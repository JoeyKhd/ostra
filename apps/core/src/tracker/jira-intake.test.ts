import { createHash, randomUUID } from "node:crypto";

import { JIRA_TOKEN_SCOPES } from "@ostra/adapter-jira";
import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord, TicketQuery, TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeJira, createFakeLinear, manualClock } from "@ostra/adapter-sdk/testing";
import type { FakeJira, FakeLinear } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { boardStateOf, postgresAuditLog, postgresChangeNotices, revokeConnectionInTx, systemClock } from "@ostra/domain";
import type { Clock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCoreServer } from "../server.ts";
import type { CoreServer } from "../server.ts";
import { FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedBoard } from "../testing/tickets.ts";
import { jobContext } from "../testing/turns.ts";
import { createWebhookInbox } from "../webhooks/inbox.ts";
import { webhookProcessHandler } from "../webhooks/process.ts";
import { buildTracker, createConnectionTrackers, verifyOnlyTrackers } from "./connections.ts";
import type { TrackerBuildInput } from "./connections.ts";
import { createPollSchedules, POLL_OVERLAP_MS, pollBoard, trackerWebhookHandler } from "./ingest.ts";
import type { TrackerIngestDeps } from "./ingest.ts";
import { checkTokenExpiry, failRefusedToken } from "./token-expiry.ts";

// Milestone 11's ticket 07, through core with the HTTP fake Jira (two sites), the fake Linear (two
// workspaces) and Postgres: Jira's webhook route (verify with the connection's own secret, claim,
// 200, then the job fetches and ingests), a pending connection activated by its first delivery,
// `410` for a disconnected connection, polling by each board's own connection, the backstop's
// silent-webhooks flag, and the token's date. Organization A holds two Jira and two Linear
// connections; organization B holds the same Jira site as A's first, which A must never see.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let globex: FakeJira;
let initech: FakeJira;
let linearOne: FakeLinear;
let linearTwo: FakeLinear;
let server: CoreServer;
let base: string;
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
/** Each `listTickets` a built adapter made: which site, and what it asked. */
const listed: { readonly site: string; readonly query: TicketQuery }[] = [];

let orgA: OrganizationId;
let orgB: OrganizationId;
let globexA: ConnectionId;
let initechA: ConnectionId;
let linearOneA: ConnectionId;
let linearTwoA: ConnectionId;
/** Organization B's polling connection to the globex site, with a token of its own. */
let globexB: ConnectionId;
let globexBoard: BoardId;
let initechBoard: BoardId;
let linearOneBoard: BoardId;
let linearTwoBoard: BoardId;
let globexBoardB: BoardId;
let globexBToken: string;

const digest = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 16);

const keep = async (organizationId: OrganizationId, purpose: string, value: string): Promise<string> => {
  const ref = await secretStore.put({ organizationId, purpose }, value);
  if (!ref.ok) throw new Error("the fake secret store refused");
  return ref.value;
};

/** Each Linear workspace's fake, by the access token it minted. */
const linearFakes = new Map<string, FakeLinear>();

/** Each connection's adapter as core builds it, pointed at its own fake: Jira's by its cloud ID, Linear's by its token. */
const build = (input: TrackerBuildInput): TrackerAdapter | null => {
  let adapter: TrackerAdapter | null;
  let site: string;
  if (input.kind === "jira") {
    const fake = [globex, initech].find((candidate) => candidate.cloudId === input.site?.cloudId);
    if (fake === undefined) return null;
    adapter = buildTracker({ jiraApiUrl: fake.gatewayUrl })(input);
    site = fake.siteHost;
  } else if (input.kind === "linear") {
    const fake = linearFakes.get(input.token);
    if (fake === undefined) return null;
    adapter = buildTracker({ linearApiUrl: fake.apiUrl })(input);
    site = fake.organization.urlKey;
  } else {
    return null;
  }
  if (adapter === null) return null;
  const list = adapter.listTickets.bind(adapter);
  adapter.listTickets = (query) => {
    listed.push({ site, query });
    return list(query);
  };
  return adapter;
};

const ingestDeps = (clock: Clock = systemClock): TrackerIngestDeps => {
  const trackers = createConnectionTrackers({ db: test.db, secretStore, clock, logger, build });
  return {
    db: test.db,
    trackers,
    notices: postgresChangeNotices,
    clock,
    logger,
    tokenRefused: (input) => failRefusedToken({ db: test.db, audit: postgresAuditLog, notices: postgresChangeNotices, clock, logger, trackers }, input),
  };
};

const seedJira = async (input: {
  readonly organizationId: OrganizationId;
  readonly fake: FakeJira;
  readonly state: "pending" | "active";
  readonly mode: "webhooks" | "polling";
  readonly name: string;
  readonly token?: string;
  readonly secret?: string | null;
}): Promise<ConnectionId> => {
  const { fake } = input;
  const secret = input.secret === undefined ? fake.webhookSecret : input.secret;
  const row = await test.db.connection.create({
    data: {
      organizationId: input.organizationId,
      kind: "jira",
      name: input.name,
      appId: fake.cloudId,
      state: input.state,
      webhookMode: input.mode,
      credentialKind: "service_account_token",
      externalWorkspaceId: fake.cloudId,
      externalWorkspaceKey: fake.siteHost,
      externalWorkspaceName: input.name,
      accountEmail: fake.serviceAccount.email,
      appUserId: fake.serviceAccount.accountId,
      appUserName: fake.serviceAccount.displayName,
      accessTokenSecretRef: await keep(input.organizationId, "jira-token", input.token ?? fake.token),
      webhookSecretSecretRef: secret === null ? null : await keep(input.organizationId, "jira-webhook-secret", secret),
      ...(input.state === "active" ? { activatedAt: new Date() } : {}),
    },
  });
  return connectionIdSchema.parse(row.id);
};

const seedLinear = async (organizationId: OrganizationId, fake: FakeLinear, name: string): Promise<ConnectionId> => {
  const app = fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example/api/linear/callback"], webhookUrl: null });
  const token = fake.mintToken("app");
  linearFakes.set(token.accessToken, fake);
  const row = await test.db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      name,
      appId: app.clientId,
      state: "active",
      webhookMode: "webhooks",
      credentialKind: "app_oauth",
      externalWorkspaceId: fake.organization.id,
      externalWorkspaceKey: fake.organization.urlKey,
      accessTokenSecretRef: await keep(organizationId, "linear-access-token", token.accessToken),
      // A refresh token of its own: a 401 is the refresh job's to settle, never an at-once failure.
      refreshTokenSecretRef: await keep(organizationId, "linear-refresh-token", token.refreshToken),
      webhookSecretSecretRef: await keep(organizationId, "linear.webhook-secret", app.webhookSecret),
      appUserId: fake.appUser()?.id ?? null,
    },
  });
  return connectionIdSchema.parse(row.id);
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  // The fakes' clocks start at the real time: deliveries and polls compare with Postgres's.
  globex = await createFakeJira({ siteName: "globex", clock: manualClock(Date.now()) });
  initech = await createFakeJira({ siteName: "initech", projectKey: "INI", clock: manualClock(Date.now()) });
  linearOne = await createFakeLinear({ urlKey: "acme" });
  linearTwo = await createFakeLinear({ urlKey: "umbrella" });
  orgA = fixture.a.organization.id;
  orgB = fixture.b.organization.id;
  const project: ProjectId = fixture.a.openProject.id;
  globexA = await seedJira({ organizationId: orgA, fake: globex, state: "active", mode: "webhooks", name: "Globex Jira" });
  initechA = await seedJira({ organizationId: orgA, fake: initech, state: "active", mode: "webhooks", name: "Initech Jira" });
  linearOneA = await seedLinear(orgA, linearOne, "Acme Linear");
  linearTwoA = await seedLinear(orgA, linearTwo, "Umbrella Linear");
  // Organization B connects the same globex site, polling, with its own service account's token.
  globexBToken = globex.mintToken(globex.serviceAccount.accountId, [...JIRA_TOKEN_SCOPES]);
  globexB = await seedJira({ organizationId: orgB, fake: globex, state: "active", mode: "polling", name: "Globex Jira", token: globexBToken, secret: null });
  globexBoard = await seedBoard(test.db, { organizationId: orgA, projectId: project, connectionId: globexA, externalId: globex.project.id, key: globex.project.key, mapping: null });
  initechBoard = await seedBoard(test.db, { organizationId: orgA, projectId: project, connectionId: initechA, externalId: initech.project.id, key: initech.project.key, mapping: null });
  linearOneBoard = await seedBoard(test.db, { organizationId: orgA, projectId: project, connectionId: linearOneA, externalId: linearOne.team.id, key: linearOne.team.key, mapping: null });
  linearTwoBoard = await seedBoard(test.db, { organizationId: orgA, projectId: project, connectionId: linearTwoA, externalId: linearTwo.team.id, key: linearTwo.team.key, mapping: null });
  globexBoardB = await seedBoard(test.db, { organizationId: orgB, projectId: fixture.b.project.id, connectionId: globexB, externalId: globex.project.id, key: globex.project.key, mapping: null });
  const inbox = createWebhookInbox({
    db: test.db,
    jobs,
    secretStore,
    // The shipped adapters' verifiers: Jira's X-Hub-Signature, Linear's own.
    trackerVerifiers: verifyOnlyTrackers({ logger: silentLogger, clock: systemClock }),
    codeHost: { verifyWebhook: () => false },
    audit: postgresAuditLog,
    notices: postgresChangeNotices,
    clock: systemClock,
    logger,
    insertDeadlineMs: 5_000,
    blocked: new Set(),
  });
  server = createCoreServer({ routes: [inbox.handle], upgrade: () => undefined, logger: silentLogger });
  base = `http://127.0.0.1:${String(await server.listen(0, "127.0.0.1"))}`;
});

afterAll(async () => {
  await server.close();
  await Promise.all([globex.close(), initech.close(), linearOne.close(), linearTwo.close()]);
  await jobs.stop({ graceful: false });
  await test.dispose();
});

type Delivery = { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string, string>> };

const post = async (kind: "jira" | "linear", connectionId: string, delivery: Delivery): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(`${base}/webhooks/${kind}/${connectionId}`, { method: "POST", headers: delivery.headers, body: delivery.rawBody });
  return { status: response.status, body: await response.json() };
};

const identifierOf = (delivery: Delivery): string => delivery.headers["x-atlassian-webhook-identifier"] ?? "";

/** `webhook.process` as core runs it, Jira's and Linear's handlers both the tracker ingest. */
const runJob = async (organizationId: OrganizationId, connectionId: ConnectionId, deliveryId: string): Promise<void> => {
  const handler = trackerWebhookHandler(ingestDeps());
  await webhookProcessHandler({ db: test.db, clock: systemClock, handlers: { linear: handler, jira: handler, github: handler } })(
    jobContext("webhook.process", { organizationId, connectionId, deliveryId: webhookDeliveryIdSchema.parse(deliveryId) }, silentLogger),
  );
};

const issueReads = (fake: FakeJira, issueId: string) => fake.calls().filter((call) => call.route === `GET /rest/api/3/issue/${issueId}`);

const recordingJobs = () => {
  const made = new Map<string, string>();
  const dropped: string[] = [];
  return {
    made,
    dropped,
    jobs: {
      schedule: (_job: string, key: string, cron: string) => {
        made.set(key, cron);
        return Promise.resolve();
      },
      unschedule: (_job: string, key: string) => {
        dropped.push(key);
        return Promise.resolve();
      },
    },
  };
};

describe("Jira's webhook, routed by connection", () => {
  it("F-008/c3: a signed delivery is claimed once and answered before its job runs, the ticket is fetched before ingest, five replays act once, a wrong signature is 401 and stored nowhere, and the service account's echo is recorded and not acted on", async () => {
    const issue = globex.createIssue({ summary: "Checkout fails on Safari; $(rm -rf /) is not a command" });
    const delivery = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.person.accountId, sentAt: Date.now() });
    const deliveryId = identifierOf(delivery);

    expect(await post("jira", globexA, delivery)).toEqual({ status: 200, body: { status: "accepted" } });
    // Answered before anything acted: the row waits, its one job is queued, Jira wasn't asked, no ticket yet.
    expect(await test.db.webhookDelivery.findMany({ where: { connectionId: globexA, deliveryId }, select: { status: true, event: true } })).toEqual([
      { status: "received", event: "jira:issue_updated" },
    ]);
    expect(await jobs.find("webhook.process", { organizationId: orgA, connectionId: globexA, deliveryId: webhookDeliveryIdSchema.parse(deliveryId) })).toHaveLength(1);
    expect(issueReads(globex, issue.id)).toHaveLength(0);
    expect(await test.db.ticket.count({ where: { connectionId: globexA, externalId: issue.id } })).toBe(0);

    // Five replays: duplicates, no new row, no new job.
    for (let replay = 0; replay < 5; replay += 1) {
      expect(await post("jira", globexA, delivery)).toEqual({ status: 200, body: { status: "duplicate" } });
    }
    expect(await test.db.webhookDelivery.count({ where: { connectionId: globexA, deliveryId } })).toBe(1);
    expect(await jobs.find("webhook.process", { organizationId: orgA, connectionId: globexA, deliveryId: webhookDeliveryIdSchema.parse(deliveryId) })).toHaveLength(1);

    // The job: the ticket read through the connection's adapter, then the cache. A replayed job acts on nothing.
    await runJob(orgA, globexA, deliveryId);
    await runJob(orgA, globexA, deliveryId);
    expect(issueReads(globex, issue.id)).toHaveLength(1);
    const tickets = await test.db.ticket.findMany({ where: { connectionId: globexA, externalId: issue.id }, select: { key: true, boardId: true } });
    expect(tickets).toEqual([{ key: issue.key, boardId: globexBoard }]);
    expect(await test.db.webhookDelivery.findFirst({ where: { connectionId: globexA, deliveryId }, select: { status: true, ticketKey: true } })).toEqual({ status: "processed", ticketKey: issue.key });
    // Organization B holds the same site and project: nothing of A's delivery reached it.
    expect(await test.db.ticket.count({ where: { organizationId: orgB } })).toBe(0);
    expect(await test.db.webhookDelivery.count({ where: { organizationId: orgB } })).toBe(0);

    // A wrong signature: 401, stored nowhere, and nothing of the body logged.
    const forged = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.person.accountId, sentAt: Date.now(), secret: "not-the-secret" });
    expect(await post("jira", globexA, forged)).toEqual({ status: 401, body: { error: "bad-signature" } });
    expect(await test.db.webhookDelivery.count({ where: { deliveryId: identifierOf(forged) } })).toBe(0);
    expect(JSON.stringify(records)).not.toContain("rm -rf");

    // The service account's own change: recorded, ignored, no new read acted on it.
    const echo = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.serviceAccount.accountId, sentAt: Date.now() });
    expect((await post("jira", globexA, echo)).status).toBe(200);
    await runJob(orgA, globexA, identifierOf(echo));
    expect(await test.db.webhookDelivery.findFirst({ where: { connectionId: globexA, deliveryId: identifierOf(echo) }, select: { status: true, error: true } })).toEqual({
      status: "ignored",
      error: "the connection's own change: recorded, not acted on",
    });
  });

  it("drops a hint for a project no board of the connection holds, with no read of the ticket", async () => {
    const elsewhere = globex.addProject("OPS", "Operations");
    const issue = globex.createIssue({ projectId: elsewhere.id, summary: "Not on any board" });
    const delivery = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.person.accountId, sentAt: Date.now() });
    expect((await post("jira", globexA, delivery)).status).toBe(200);
    await runJob(orgA, globexA, identifierOf(delivery));
    expect(issueReads(globex, issue.id)).toHaveLength(0);
    expect(await test.db.webhookDelivery.findFirst({ where: { connectionId: globexA, deliveryId: identifierOf(delivery) }, select: { status: true, error: true } })).toEqual({
      status: "ignored",
      error: "the ticket is on no attached board",
    });
  });

  it("F-008/c1: a pending Jira connection's first valid delivery activates it; a bad one sets badSignatureAt and leaves it pending", async () => {
    // Organization B's second step on another site: token saved, secret made, no delivery yet.
    const pending = await seedJira({ organizationId: orgB, fake: initech, state: "pending", mode: "webhooks", name: "Initech Jira", secret: "a-secret-only-this-connection-holds" });
    const issue = initech.createIssue({ summary: "The first event" });

    const bad = initech.signedDelivery({ issueId: issue.id, byAccountId: initech.person.accountId, sentAt: Date.now() });
    expect((await post("jira", pending, bad)).status).toBe(401);
    const refused = await test.db.connection.findUniqueOrThrow({ where: { id: pending } });
    expect(refused.state).toBe("pending");
    expect(refused.badSignatureAt).not.toBeNull();
    expect(refused.firstDeliveryAt).toBeNull();
    expect(await test.db.webhookDelivery.count({ where: { connectionId: pending } })).toBe(0);

    const good = initech.signedDelivery({ issueId: issue.id, byAccountId: initech.person.accountId, sentAt: Date.now(), secret: "a-secret-only-this-connection-holds" });
    expect(await post("jira", pending, good)).toEqual({ status: 200, body: { status: "accepted" } });
    const connected = await test.db.connection.findUniqueOrThrow({ where: { id: pending } });
    expect(connected.state).toBe("active");
    expect(connected.firstDeliveryAt).not.toBeNull();
    expect(connected.activatedAt).not.toBeNull();
    expect(connected.badSignatureAt).toBeNull();
    expect(await test.db.auditEntry.count({ where: { organizationId: orgB, action: "tracker.connected", entityId: pending } })).toBe(1);
    // Organization A's connection to the same site is untouched.
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: initechA } })).firstDeliveryAt).toBeNull();
  });
});

describe("two clients' connections kept apart", () => {
  it("F-152/c3: two Jira and two Linear connections in one organization: a delivery signed with another's secret is refused at the other's address, and each poll and fetch goes with its own connection's credential", async () => {
    // Globex's delivery, rightly signed for globex, sent to initech's address: initech's secret refuses it.
    const issue = globex.createIssue({ summary: "For globex only" });
    const crossed = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.person.accountId, sentAt: Date.now() });
    expect((await post("jira", initechA, crossed)).status).toBe(401);
    // And the other way round: initech's own secret signs a delivery globex's address refuses.
    const back = initech.signedDelivery({ issueId: initech.createIssue({ summary: "For initech only" }).id, byAccountId: initech.person.accountId, sentAt: Date.now() });
    expect((await post("jira", globexA, back)).status).toBe(401);
    // Linear's: the first workspace's app signs, the second connection's address refuses.
    const linearIssue = await linearOne.createIssue({ title: "For acme only" });
    const linearCrossed = linearOne.signedDelivery({ issueId: linearIssue.id, byUserId: linearOne.admin.id, sentAt: Date.now() });
    expect((await post("linear", linearTwoA, linearCrossed)).status).toBe(400);
    expect(await post("linear", linearOneA, linearCrossed)).toEqual({ status: 200, body: { status: "accepted" } });
    expect(await test.db.webhookDelivery.count({ where: { connectionId: { in: [initechA, linearTwoA] } } })).toBe(0);

    // Each poll, by its board's own connection: every call to a site carries that connection's token.
    await linearTwo.createIssue({ title: "For umbrella only" });
    const deps = ingestDeps();
    for (const board of [globexBoard, initechBoard, linearOneBoard, linearTwoBoard]) {
      expect((await pollBoard(deps, { organizationId: orgA, boardId: board })).outcome).toBe("polled");
    }
    expect(await pollBoard(deps, { organizationId: orgB, boardId: globexBoardB })).toMatchObject({ outcome: "polled" });
    const globexCredentials = new Set(globex.calls().map((call) => call.credential));
    expect(globexCredentials).toEqual(new Set([digest(globex.token), digest(globexBToken)]));
    expect(new Set(initech.calls().map((call) => call.credential))).toEqual(new Set([digest(initech.token)]));
    // Organization B's poll asked with B's token only: its board holds the site's tickets, A's rows none of B's.
    const bTickets = await test.db.ticket.findMany({ where: { organizationId: orgB }, select: { connectionId: true } });
    expect(bTickets.length).toBeGreaterThan(0);
    expect(new Set(bTickets.map((row) => row.connectionId))).toEqual(new Set([globexB]));
    // Each Linear workspace was asked by its own connection, and each board holds its own workspace's tickets only.
    expect(listed.filter((call) => call.site === "acme")).not.toHaveLength(0);
    expect(listed.filter((call) => call.site === "umbrella")).not.toHaveLength(0);
    const titles = async (boardId: BoardId) => (await test.db.ticket.findMany({ where: { boardId }, select: { title: true } })).map((row) => row.title);
    expect(await titles(linearOneBoard)).toContain("For acme only");
    expect(await titles(linearOneBoard)).not.toContain("For umbrella only");
    expect(await titles(linearTwoBoard)).toContain("For umbrella only");
    expect(await titles(linearTwoBoard)).not.toContain("For acme only");
    expect(await titles(initechBoard)).not.toContain("For globex only");
  });
});

describe("polling every kind", () => {
  it("F-008/c4: with no webhook, a ticket edited on Jira is ingested by polling within one poll period; with webhooks, the 5-minute backstop finds a change no delivery brought and sets webhooksSilentSince", async () => {
    // The schedules: B's polling connection every OSTRA_TRACKER_POLL_SECONDS (60 s), A's webhook ones every 5 minutes.
    const recorded = recordingJobs();
    await createPollSchedules({ db: test.db, jobs: recorded.jobs, pollSeconds: 60, reconcileMinutes: 5, logger }).ensure();
    expect(recorded.made.get(globexBoardB)).toBe("* * * * *");
    expect(recorded.made.get(globexBoard)).toBe("*/5 * * * *");
    expect(recorded.made.get(initechBoard)).toBe("*/5 * * * *");
    expect(recorded.made.get(linearOneBoard)).toBe("*/5 * * * *");

    // No webhook: organization B's board, polled from its cursor, finds the edit on the next tick.
    const issue = globex.createIssue({ summary: "Before the edit" });
    const deps = ingestDeps();
    await pollBoard(deps, { organizationId: orgB, boardId: globexBoardB });
    globex.clock.advance(30_000);
    globex.editIssue(issue.id, { summary: "After the edit" });
    const polled = await pollBoard(deps, { organizationId: orgB, boardId: globexBoardB });
    expect(polled).toMatchObject({ outcome: "polled" });
    expect(await test.db.ticket.findFirst({ where: { boardId: globexBoardB, externalId: issue.id }, select: { title: true } })).toEqual({ title: "After the edit" });

    // With webhooks: a change made 15 minutes after the last delivery, which no delivery brought.
    await pollBoard(deps, { organizationId: orgA, boardId: globexBoard });
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: globexA } })).webhooksSilentSince).toBeNull();
    globex.clock.advance(15 * 60_000);
    const unsent = globex.createIssue({ summary: "Jira never sent this one" });
    const backstop = await pollBoard(deps, { organizationId: orgA, boardId: globexBoard });
    expect(backstop).toMatchObject({ outcome: "polled" });
    expect(await test.db.ticket.count({ where: { boardId: globexBoard, externalId: unsent.id } })).toBe(1);
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: globexA } })).webhooksSilentSince).not.toBeNull();
    // Organization B's connection to the same site keeps its own flag.
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: globexB } })).webhooksSilentSince).toBeNull();
  });

  it("F-152/c5: a revoked connection's address answers 410; its boards aren't polled; after a resume they're polled from their cursors", async () => {
    const cursor = (await test.db.board.findUniqueOrThrow({ where: { id: globexBoardB } })).pollCursor;
    expect(cursor).not.toBeNull();
    await test.db.$transaction((tx) =>
      revokeConnectionInTx({ tx, audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock }, { organizationId: orgB, connectionId: globexB, kind: "jira", actor: { kind: "system", id: null } }),
    );
    // Disconnected: deliveries are gone (410), stored nowhere; an unknown Jira address too.
    const issue = globex.createIssue({ summary: "After the disconnect" });
    const delivery = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.person.accountId, sentAt: Date.now() });
    expect(await post("jira", globexB, delivery)).toEqual({ status: 410, body: { error: "gone" } });
    expect(await post("jira", randomUUID(), delivery)).toEqual({ status: 410, body: { error: "gone" } });
    expect(await test.db.webhookDelivery.count({ where: { deliveryId: identifierOf(delivery) } })).toBe(0);
    // Its board pauses: no schedule, and a poll that runs anyway reads nothing.
    const recorded = recordingJobs();
    const schedules = createPollSchedules({ db: test.db, jobs: recorded.jobs, pollSeconds: 60, reconcileMinutes: 5, logger });
    await schedules.ensure();
    expect(recorded.made.has(globexBoardB)).toBe(false);
    const before = listed.length;
    expect(await pollBoard(ingestDeps(), { organizationId: orgB, boardId: globexBoardB })).toEqual({ outcome: "skipped", reason: "the board is paused" });
    expect(listed.length).toBe(before);

    // The same site connected again: its first delivery activates it and resumes the paused board.
    const successor = await seedJira({ organizationId: orgB, fake: globex, state: "pending", mode: "webhooks", name: "Globex Jira again", token: globexBToken, secret: "the-successor's-secret" });
    const first = globex.signedDelivery({ issueId: issue.id, byAccountId: globex.person.accountId, sentAt: Date.now(), secret: "the-successor's-secret" });
    expect((await post("jira", successor, first)).status).toBe(200);
    const board = await test.db.board.findUniqueOrThrow({ where: { id: globexBoardB }, include: { connection: true } });
    expect(board.connectionId).toBe(successor);
    expect(boardStateOf(board, board.connection).state).toBe("attached");
    await schedules.ensure();
    expect(recorded.made.get(globexBoardB)).toBe("*/5 * * * *");
    expect(await pollBoard(ingestDeps(), { organizationId: orgB, boardId: globexBoardB })).toMatchObject({ outcome: "polled" });
    // From its own cursor, less the overlap: nothing re-read from the start.
    const asked = listed.slice(before).find((call) => call.site === globex.siteHost);
    expect(asked?.query.updatedSince).toBe((cursor?.getTime() ?? 0) - POLL_OVERLAP_MS);
    // Organization A's connection to the site never moved.
    expect((await test.db.board.findUniqueOrThrow({ where: { id: globexBoard } })).connectionId).toBe(globexA);
  });
});

describe("the token's date", () => {
  const DAY = 86_400_000;
  const dateOnly = (ms: number): Date => new Date(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`);

  it("F-008/c8: the expiry job warns once 14 days before and fails the connection on the day; a 401 on the saved token fails it at once", async () => {
    const now = Date.now();
    const expiresOn = dateOnly(now + 14 * DAY);
    await test.db.connection.update({ where: { id: globexA }, data: { tokenExpiresOn: expiresOn } });
    const deps = { db: test.db, audit: postgresAuditLog, notices: postgresChangeNotices, logger, trackers: { forget: () => undefined } };

    // 15 days before: nothing. 14 days before: one warning, the next day's run adds none.
    expect(await checkTokenExpiry({ ...deps, clock: { now: () => now - DAY } })).toEqual({ warned: 0, failed: 0 });
    expect(await checkTokenExpiry({ ...deps, clock: { now: () => now } })).toEqual({ warned: 1, failed: 0 });
    expect(await checkTokenExpiry({ ...deps, clock: { now: () => now + DAY } })).toEqual({ warned: 0, failed: 0 });
    const warnings = await test.db.auditEntry.findMany({ where: { action: "tracker.token-expiring" }, select: { organizationId: true, entityId: true, data: true } });
    expect(warnings).toEqual([{ organizationId: orgA, entityId: globexA, data: { kind: "jira", expiresOn: expiresOn.toISOString().slice(0, 10), days: 14 } }]);
    expect((await test.db.connection.findUniqueOrThrow({ where: { id: globexA } })).state).toBe("active");

    // On the day: failed, its boards paused.
    expect(await checkTokenExpiry({ ...deps, clock: { now: () => expiresOn.getTime() + 3_600_000 } })).toEqual({ warned: 0, failed: 1 });
    const expired = await test.db.connection.findUniqueOrThrow({ where: { id: globexA } });
    expect({ state: expired.state, failedReason: expired.failedReason }).toEqual({ state: "failed", failedReason: "token-expired" });
    expect(await pollBoard(ingestDeps(), { organizationId: orgA, boardId: globexBoard })).toEqual({ outcome: "skipped", reason: "the board is paused" });

    // Jira refuses initech's saved token: the next call fails the connection at once.
    initech.refuseToken(initech.token, 401);
    expect(await pollBoard(ingestDeps(), { organizationId: orgA, boardId: initechBoard })).toEqual({ outcome: "skipped", reason: "the tracker refused the connection's token" });
    const refused = await test.db.connection.findUniqueOrThrow({ where: { id: initechA } });
    expect({ state: refused.state, failedReason: refused.failedReason }).toEqual({ state: "failed", failedReason: "token-refused" });
    expect(await test.db.auditEntry.count({ where: { action: "tracker.failed", entityId: { in: [globexA, initechA] } } })).toBe(2);
    // The other connections, and organization B's, carry on.
    for (const id of [linearOneA, linearTwoA]) {
      expect((await test.db.connection.findUniqueOrThrow({ where: { id } })).state).toBe("active");
    }
    expect(await test.db.connection.count({ where: { organizationId: orgB, state: "failed" } })).toBe(0);
  });
});
