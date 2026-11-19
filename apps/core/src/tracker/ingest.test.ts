import { randomUUID } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord, TicketQuery, TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, FakeLinearApp } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, externalTicketIdSchema, organizationIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ExternalTicketId, OrganizationId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeSecretStore } from "../testing/fake-adapters.ts";
import { mappingFor, seedBoard } from "../testing/tickets.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { createConnectionTrackers } from "./connections.ts";
import type { TrackerBuildInput } from "./connections.ts";
import { createPollSchedules, cronEveryMinutes, pollBoard, POLL_OVERLAP_MS, trackerWebhookHandler } from "./ingest.ts";
import type { TrackerIngestDeps } from "./ingest.ts";
import { ensureTokenRefreshes, refreshConnectionToken } from "./refresh-token.ts";

// Ticket 14's cases, against the fake Linear server through the real Linear adapter: a webhook hint
// fetches and upserts; the app's own change isn't acted on; a moved ticket keeps its row and gets
// its new key; polling with webhooks off finds a change; a cut in the middle of a page loses
// nothing and stores nothing twice; the cursor survives a restart; the token refreshes before it
// expires, and a refused refresh fails visibly. Then, gated on `linear.env`, the live poll.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let fake: FakeLinear;
let app: FakeLinearApp;
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
let organizationId: OrganizationId;
let connectionId: ConnectionId;
let boardId: BoardId;
let otherBoardId: BoardId;
let appUserId: string;
let otherTeamId: string;
const queries: TicketQuery[] = [];

/** The Linear adapter as core builds it, its `listTickets` calls recorded. */
const build = (input: TrackerBuildInput): TrackerAdapter => {
  const adapter = new LinearAdapter(
    { auth: input.credentialKind === "api_key" ? { kind: "api-key", token: input.token } : { kind: "oauth", token: input.token }, apiUrl: fake.apiUrl },
    input.context,
  );
  const list = adapter.listTickets.bind(adapter);
  adapter.listTickets = (query) => {
    queries.push(query);
    return list(query);
  };
  return adapter;
};

const deps = (): TrackerIngestDeps => ({
  db: test.db,
  trackers: createConnectionTrackers({ db: test.db, secretStore, clock: systemClock, logger, build }),
  notices: postgresChangeNotices,
  clock: systemClock,
  logger,
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  fake = await createFakeLinear({ retryDelaysMs: [10, 10, 10] });
  app = fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example/api/linear/callback"], webhookUrl: null });
  const token = fake.mintToken("app");
  appUserId = fake.appUser()?.id ?? "";
  organizationId = fixture.a.organization.id;
  const access = await secretStore.put({ organizationId, purpose: "linear-access-token" }, token.accessToken);
  const refresh = await secretStore.put({ organizationId, purpose: "linear-refresh-token" }, token.refreshToken);
  const clientSecret = await secretStore.put({ organizationId, purpose: "linear-client-secret" }, app.clientSecret);
  if (!access.ok || !refresh.ok || !clientSecret.ok) throw new Error("the fake secret store refused");
  const row = await test.db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: app.clientId,
      state: "active",
      webhookMode: "polling",
      credentialKind: "app_oauth",
      accessTokenSecretRef: access.value,
      refreshTokenSecretRef: refresh.value,
      clientSecretSecretRef: clientSecret.value,
      accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000),
      appUserId,
    },
  });
  connectionId = connectionIdSchema.parse(row.id);
  const adapter = build({ kind: "linear", credentialKind: "app_oauth", token: token.accessToken, context: { logger: silentLogger, clock: systemClock } });
  const statuses = await adapter.listStatuses({ externalId: fake.team.id });
  if (!statuses.ok) throw new Error(statuses.error.message);
  const mapping = mappingFor(statuses.value, "ostra");
  boardId = await seedBoard(test.db, { organizationId, projectId: fixture.a.openProject.id, connectionId, externalId: fake.team.id, key: "OST", mapping });
  otherTeamId = fake.addTeam("OPS", "Operations").id;
  otherBoardId = await seedBoard(test.db, { organizationId, projectId: fixture.a.restrictedProject.id, connectionId, externalId: otherTeamId, key: "OPS", mapping });
});

afterAll(async () => {
  await fake.close();
  await jobs.stop({ graceful: false });
  await test.dispose();
});

const deliveryContext = (body: Uint8Array): WebhookDeliveryContext => {
  const payload: unknown = JSON.parse(new TextDecoder().decode(body));
  return {
    organizationId,
    connectionId,
    deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
    event: "Issue.update",
    payload,
    receivedAt: Date.now(),
    logger,
  };
};

const rowsOf = (externalId: ExternalTicketId) => test.db.ticket.findMany({ where: { externalId }, orderBy: { createdAt: "asc" } });

describe("a webhook hint", () => {
  it("fetches the ticket through the adapter and upserts its copy by board and stable ID, with its key", async () => {
    const issue = await fake.createIssue({ title: "Login button does nothing", labels: ["bug"] });
    const delivery = fake.signedDelivery({ issueId: issue.id, byUserId: fake.admin.id, sentAt: Date.now() });
    const outcome = await trackerWebhookHandler(deps())(deliveryContext(delivery.rawBody));
    expect(outcome).toEqual({ outcome: "processed", ticketKey: issue.identifier });
    const [row] = await rowsOf(issue.id);
    expect(row).toMatchObject({ boardId, key: issue.identifier, title: "Login button does nothing", labels: ["bug"], open: true, removedAt: null, statusCategory: "open" });
    // The same hint again changes nothing.
    await trackerWebhookHandler(deps())(deliveryContext(delivery.rawBody));
    expect(await rowsOf(issue.id)).toHaveLength(1);
  });

  it("records a change by the app's own user without acting on it, and still keeps the copy current", async () => {
    const issue = await fake.createIssue({ title: "Our own echo" });
    await fake.editIssue(issue.id, { title: "Our own echo, edited" });
    const delivery = fake.signedDelivery({ issueId: issue.id, byUserId: appUserId, sentAt: Date.now() });
    const outcome = await trackerWebhookHandler(deps())(deliveryContext(delivery.rawBody));
    expect(outcome).toMatchObject({ outcome: "ignored", ticketKey: issue.identifier });
    expect((await rowsOf(issue.id))[0]?.title).toBe("Our own echo, edited");
  });

  it("keeps a moved ticket's row, with its new key, and caches it on the board it moved to", async () => {
    const issue = await fake.createIssue({ title: "Belongs to ops" });
    await trackerWebhookHandler(deps())(deliveryContext(fake.signedDelivery({ issueId: issue.id, byUserId: fake.admin.id, sentAt: Date.now() }).rawBody));
    const task = await test.db.task.create({
      data: {
        organizationId,
        projectId: fixture.a.openProject.id,
        kind: "code",
        source: "ticket",
        title: "Belongs to ops",
        ticketKey: issue.identifier,
        ticketId: (await rowsOf(issue.id))[0]?.id ?? null,
        boardId,
        branchName: `ostra/${randomUUID().slice(0, 8)}`,
        state: "stopped",
        stoppedReason: "requested",
      },
    });
    const newKey = await fake.moveIssue(issue.id, otherTeamId);
    await trackerWebhookHandler(deps())(deliveryContext(fake.signedDelivery({ issueId: issue.id, byUserId: fake.admin.id, sentAt: Date.now() }).rawBody));
    const rows = await rowsOf(issue.id);
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => row.boardId === boardId);
    const moved = rows.find((row) => row.boardId === otherBoardId);
    expect(old).toMatchObject({ key: newKey, open: false });
    expect(old?.removedAt).not.toBeNull();
    expect(moved).toMatchObject({ key: newKey, removedAt: null });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.id } })).ticketKey).toBe(newKey);
  });

  it("ignores a delivery about no ticket, and fails one whose connection isn't active", async () => {
    const outcome = await trackerWebhookHandler(deps())({ ...deliveryContext(new TextEncoder().encode(JSON.stringify({ type: "Project", action: "update", data: {} }))) });
    expect(outcome.outcome).toBe("ignored");
    const other = organizationIdSchema.parse(fixture.b.organization.id);
    const failed = await trackerWebhookHandler(deps())({ ...deliveryContext(new TextEncoder().encode("{}")), organizationId: other });
    expect(failed).toMatchObject({ outcome: "failed" });
  });
});

describe("polling", () => {
  it("with webhooks off, finds a new ticket and a change in one poll, and moves the cursor", async () => {
    fake.setWebhooksPaused(true);
    const issue = await fake.createIssue({ title: "Arrives by polling" });
    const first = await pollBoard(deps(), { organizationId, boardId });
    expect(first).toMatchObject({ outcome: "polled" });
    expect(await rowsOf(issue.id)).toHaveLength(1);
    await fake.editIssue(issue.id, { title: "Arrives by polling, edited" });
    const second = await pollBoard(deps(), { organizationId, boardId });
    expect(second).toMatchObject({ outcome: "polled", changed: 1 });
    expect((await rowsOf(issue.id))[0]?.title).toBe("Arrives by polling, edited");
    const board = await test.db.board.findUniqueOrThrow({ where: { id: boardId } });
    expect(board.pollCursor?.getTime()).toBe((await rowsOf(issue.id))[0]?.trackerUpdatedAt.getTime());
    expect(board.lastPollChanged).toBe(1);
    // A third poll asks from the cursor, minus the overlap, oldest change first.
    queries.length = 0;
    await pollBoard(deps(), { organizationId, boardId });
    expect(queries[0]).toMatchObject({ order: "updatedAt", updatedSince: (board.pollCursor?.getTime() ?? 0) - POLL_OVERLAP_MS });
  });

  it("a cut in the middle of a page loses nothing and stores nothing twice", async () => {
    const before = await test.db.board.findUniqueOrThrow({ where: { id: boardId } });
    const made = [];
    for (let index = 0; index < 5; index += 1) {
      fake.clock.advance(1000);
      made.push(await fake.createIssue({ title: `Page ticket ${String(index)}` }));
    }
    // The third ticket's text can't be stored (Postgres refuses a NUL): its page's transaction fails midway.
    fake.clock.advance(1000);
    await fake.editIssue((made[2] ?? made[0])?.id ?? externalTicketIdSchema.parse("missing"), { title: "Broken \u0000 title" });
    await expect(pollBoard(deps(), { organizationId, boardId }, { pageSize: 50 })).rejects.toThrow();
    for (const issue of made) {
      expect(await rowsOf(issue.id)).toHaveLength(0);
    }
    expect((await test.db.board.findUniqueOrThrow({ where: { id: boardId } })).pollCursor?.getTime()).toBe(before.pollCursor?.getTime());
    // Fixed on the tracker: the next poll stores every ticket once, from the same cursor.
    fake.clock.advance(1000);
    await fake.editIssue((made[2] ?? made[0])?.id ?? externalTicketIdSchema.parse("missing"), { title: "Fixed title" });
    await pollBoard(deps(), { organizationId, boardId }, { pageSize: 2 });
    for (const issue of made) {
      expect(await rowsOf(issue.id)).toHaveLength(1);
    }
  });

  it("the cursor survives a restart: a new core polls from where the last left off", async () => {
    const issue = await fake.createIssue({ title: "After the restart" });
    queries.length = 0;
    // A fresh set of deps is a fresh core: its only memory is the board's row.
    const cursor = (await test.db.board.findUniqueOrThrow({ where: { id: boardId } })).pollCursor?.getTime() ?? 0;
    await pollBoard(deps(), { organizationId, boardId });
    expect(queries[0]?.updatedSince).toBe(cursor - POLL_OVERLAP_MS);
    expect(await rowsOf(issue.id)).toHaveLength(1);
  });

  it("flags a webhook connection whose webhooks went silent while polling found changes, and keeps its mode", async () => {
    await test.db.connection.update({ where: { id: connectionId }, data: { webhookMode: "webhooks" } });
    fake.clock.advance(20 * 60_000);
    await fake.createIssue({ title: "Missed by the webhooks" });
    await pollBoard(deps(), { organizationId, boardId });
    const connection = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(connection.webhooksSilentSince).not.toBeNull();
    expect(connection.webhookMode).toBe("webhooks");
    await test.db.connection.update({ where: { id: connectionId }, data: { webhookMode: "polling", webhooksSilentSince: null } });
  });

  it("makes a schedule per attached board, every interval, and drops it when the board is detached", async () => {
    expect(cronEveryMinutes(1)).toBe("* * * * *");
    expect(cronEveryMinutes(5)).toBe("*/5 * * * *");
    expect(cronEveryMinutes(0.5)).toBe("* * * * *");
    const made: { readonly key: string; readonly cron: string }[] = [];
    const dropped: string[] = [];
    const schedules = createPollSchedules({
      db: test.db,
      jobs: {
        schedule: (_job, key, cron) => {
          made.push({ key, cron });
          return Promise.resolve();
        },
        unschedule: (_job, key) => {
          dropped.push(key);
          return Promise.resolve();
        },
      },
      pollSeconds: 60,
      reconcileMinutes: 5,
      logger,
    });
    await schedules.ensure();
    expect(made).toContainEqual({ key: boardId, cron: "* * * * *" });
    // Nothing changed: nothing is sent again.
    const count = made.length;
    await schedules.ensure();
    expect(made).toHaveLength(count);
    await test.db.board.update({ where: { id: otherBoardId }, data: { detachedAt: new Date() } });
    await schedules.ensure();
    expect(dropped).toContain(otherBoardId);
    await test.db.board.update({ where: { id: otherBoardId }, data: { detachedAt: null } });
    // Against pg-boss itself: the schedule is made.
    await createPollSchedules({ db: test.db, jobs, pollSeconds: 60, reconcileMinutes: 5, logger }).ensure();
  });
});

describe("linear.refresh-token", () => {
  const refreshDeps = () => ({
    db: test.db,
    jobs,
    secretStore,
    trackers: { forget: () => undefined },
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    logger,
    tokenUrl: fake.tokenUrl,
  });

  it("refreshes before the token expires, keeps the rotated pair in the secret store, and drops the old one", async () => {
    await test.db.connection.update({ where: { id: connectionId }, data: { accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000) } });
    const before = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    const outcome = await refreshConnectionToken(refreshDeps(), { organizationId, connectionId });
    expect(outcome.outcome).toBe("refreshed");
    const after = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after.accessTokenSecretRef).not.toBe(before.accessTokenSecretRef);
    expect(after.refreshTokenSecretRef).not.toBe(before.refreshTokenSecretRef);
    expect(after.accessTokenExpiresAt?.getTime()).toBeGreaterThan(before.accessTokenExpiresAt?.getTime() ?? 0);
    expect(secretStore.entries.has(before.accessTokenSecretRef ?? "")).toBe(false);
    // The new token works: a poll reads Linear with it.
    expect(await pollBoard(deps(), { organizationId, boardId })).toMatchObject({ outcome: "polled" });
    // Not due yet: a timer sent early does nothing.
    expect((await refreshConnectionToken(refreshDeps(), { organizationId, connectionId })).outcome).toBe("not-due");
    // Its next run is queued, an hour before the new expiry.
    await ensureTokenRefreshes(refreshDeps());
    const queued = await jobs.find("linear.refresh-token", { organizationId, connectionId });
    expect(queued.some((job) => job.state === "created")).toBe(true);
  });

  it("marks the connection failed when Linear refuses the refresh, and its polling stops, visibly", async () => {
    const bad = await secretStore.put({ organizationId, purpose: "linear-refresh-token" }, "not-a-refresh-token");
    if (!bad.ok) throw new Error("refused");
    await test.db.connection.update({ where: { id: connectionId }, data: { refreshTokenSecretRef: bad.value, accessTokenExpiresAt: new Date(Date.now() + 60_000) } });
    const outcome = await refreshConnectionToken(refreshDeps(), { organizationId, connectionId });
    expect(outcome.outcome).toBe("failed");
    const connection = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(connection.state).toBe("failed");
    expect(connection.failedReason).toContain("authorize the Linear app again");
    expect(await pollBoard(deps(), { organizationId, boardId })).toMatchObject({ outcome: "skipped" });
    const audit = await test.db.auditEntry.findFirst({ where: { action: "linear.token-refresh-failed", entityId: connectionId } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(records)).not.toContain("not-a-refresh-token");
  });
});

// ---------- live, gated on linear.env ----------

const live = z.object({ LINEAR_API_KEY: z.string().min(1), LINEAR_TEST_TEAM_ID: z.string().min(1) }).safeParse(process.env);

describe.skipIf(!live.success)("live: a ticket created in OST reaches the cache through polling", () => {
  it("within 60 s", { timeout: 120_000 }, async () => {
    if (!live.success) return;
    const { LINEAR_API_KEY: key, LINEAR_TEST_TEAM_ID: teamId } = live.data;
    const call = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
      });
      const body: unknown = await response.json();
      return z.looseObject({ data: z.unknown() }).parse(body).data;
    };
    const organization = organizationIdSchema.parse(fixture.b.organization.id);
    const ref = await secretStore.put({ organizationId: organization, purpose: "linear-access-token" }, key);
    if (!ref.ok) throw new Error("refused");
    const row = await test.db.connection.create({
      data: { organizationId: organization, kind: "linear", appId: "api-key", state: "active", webhookMode: "polling", credentialKind: "api_key", accessTokenSecretRef: ref.value },
    });
    const liveDeps: TrackerIngestDeps = {
      ...deps(),
      trackers: createConnectionTrackers({ db: test.db, secretStore, clock: systemClock, logger }),
    };
    const liveBoard = await seedBoard(test.db, {
      organizationId: organization,
      projectId: fixture.b.project.id,
      connectionId: connectionIdSchema.parse(row.id),
      externalId: teamId,
      key: "OST",
      mapping: null,
    });
    // The first poll is the board's backfill; the ticket is made after it.
    await test.db.board.update({ where: { id: liveBoard }, data: { pollCursor: new Date(Date.now() - 60_000) } });
    const created = z
      .object({ issueCreate: z.object({ issue: z.object({ id: z.string() }) }) })
      .parse(await call("mutation ($teamId: String!, $title: String!) { issueCreate(input: { teamId: $teamId, title: $title }) { issue { id } } }", { teamId, title: `ostra live poll ${randomUUID().slice(0, 8)}` }));
    const started = Date.now();
    try {
      let found = false;
      while (!found && Date.now() - started < 60_000) {
        await pollBoard(liveDeps, { organizationId: organization, boardId: liveBoard });
        found = (await test.db.ticket.count({ where: { boardId: liveBoard, externalId: created.issueCreate.issue.id } })) === 1;
        if (!found) await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      expect(found).toBe(true);
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      await call("mutation ($id: String!) { issueArchive(id: $id) { success } }", { id: created.issueCreate.issue.id });
    }
  });
});
