import { createHmac, randomUUID } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, FakeLinearApp } from "@ostra/adapter-sdk/testing";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  rejectOutsideTask,
  systemClock,
  upsertTicketCacheInTx,
} from "@ostra/domain";
import type { MemberScope, Ports } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, memberIdSchema, taskIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCoreServer } from "../../server.ts";
import type { CoreServer } from "../../server.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../../testing/fake-adapters.ts";
import { seedBoard } from "../../testing/tickets.ts";
import { seedWorld } from "../../testing/world.ts";
import { createConnectionTrackers } from "../../tracker/connections.ts";
import type { ConnectionTrackers } from "../../tracker/connections.ts";
import { createWebhookInbox } from "../../webhooks/inbox.ts";
import { agentEventHandler, handleAgentSessionEvent } from "./events.ts";
import type { AgentModeDeps } from "./events.ts";
import { activitySendHandler } from "./outbox.ts";

// The burst CI found (run 44818964002, ticket 38's rehearsal): 50 delegations, 250 ms apart, then
// one member's answer to each at once, on a database pool smaller than the burst. Prisma gives an
// interactive transaction 2 s by default to get a pooled connection and then throws P2028 ("Unable
// to start a transaction in the given time") instead of waiting its turn, so a burst that queues
// longer than that lost its rejects (the rehearsal's bullet 2), and core's own agent-event jobs
// went back to the queue's backoff, late for Linear's 10 s. Here core's inbox, its agent-event job
// and its outbox all share one pool of POOL connections, as one core shares its own; and for the
// answers, long transactions hold every connection for longer than Prisma's 2 s.

const PUBLIC_URL = "https://ostra.example";
const AGENT_SCOPES = [
  "read",
  "write",
  "issues:create",
  "comments:create",
  "app:assignable",
  "app:mentionable",
];
const DELEGATIONS = 50;
/** The rehearsal's rate: one delegation every 250 ms. */
const SPACING_MS = 250;
const POOL = 3;
/** Longer than Prisma's own 2 s wait for a connection. */
const HOLD_MS = 3_000;

let test: TestDatabase;
let fixture: IsolationFixture;
/** Core's database client, on a small pool. */
let small: Db;
let jobs: Jobs;
let fake: FakeLinear;
let app: FakeLinearApp;
let organizationId: OrganizationId;
let projectId: ProjectId;
let connectionId: ConnectionId;
let inboxUrl: string;
let boardId: string;
let trackers: ConnectionTrackers;
let agentMode: AgentModeDeps;
const secretStore = new FakeSecretStore();
const codeHost = new FakeCodeHost();
const servers: CoreServer[] = [];

/** The session's event as Linear sends it: signed with the app's webhook secret, stamped now. */
const signed = (
  body: unknown,
  deliveryId: string,
): { readonly body: string; readonly headers: Record<string, string> } => {
  const stamped = JSON.stringify({
    ...(typeof body === "object" && body !== null ? body : {}),
    webhookTimestamp: Date.now(),
  });
  return {
    body: stamped,
    headers: {
      "content-type": "application/json",
      "linear-delivery": deliveryId,
      "linear-event": "AgentSessionEvent",
      "linear-signature": createHmac("sha256", app.webhookSecret).update(stamped).digest("hex"),
    },
  };
};

/** Waits for `check`, polling, for at most `ms`; `true` when it held in time. */
const until = async (check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  small = createDb(test.url, { maxConnections: POOL });
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  await seedWorld(test.db, { codeHost, secretStore }, organizationId, projectId);
  // Outside tasks wait for a member's answer: the delegations' creator matches no member.
  await test.db.project.update({ where: { id: projectId }, data: { outsideApproval: true } });
  fake = await createFakeLinear();
  app = fake.createApp({
    name: "ostra",
    redirectUris: [`${PUBLIC_URL}/api/linear/callback`],
    webhookUrl: null,
  });
  const token = fake.mintToken("app", AGENT_SCOPES);
  const access = await secretStore.put(
    { organizationId, purpose: "linear-access-token" },
    token.accessToken,
  );
  const webhookSecret = await secretStore.put(
    { organizationId, purpose: "linear.webhook-secret" },
    app.webhookSecret,
  );
  if (!access.ok || !webhookSecret.ok) throw new Error("the fake secret store refused");
  const row = await test.db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: app.clientId,
      state: "active",
      webhookMode: "webhooks",
      credentialKind: "app_oauth",
      accessTokenSecretRef: access.value,
      webhookSecretSecretRef: webhookSecret.value,
      accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000),
      appUserId: fake.appUser()?.id ?? null,
      scopes: AGENT_SCOPES,
      agentModeAt: new Date(),
    },
  });
  connectionId = connectionIdSchema.parse(row.id);
  boardId = await seedBoard(test.db, {
    organizationId,
    projectId,
    connectionId,
    externalId: fake.team.id,
    key: "OST",
    mapping: null,
  });
  await test.db.board.update({ where: { id: boardId }, data: { agentMode: true } });
  trackers = createConnectionTrackers({
    db: small,
    secretStore,
    clock: systemClock,
    logger: silentLogger,
    build: (input) =>
      input.kind === "linear"
        ? new LinearAdapter({ apiUrl: fake.apiUrl, auth: { kind: "oauth", token: input.token } }, input.context)
        : null,
  });
  agentMode = {
    db: small,
    jobs,
    outbox: postgresCommandOutbox,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    trackers,
    publicUrl: PUBLIC_URL,
    logger: silentLogger,
    heartbeatMs: 20 * 60_000,
  };
  await jobs.work("linear.agent-event", agentEventHandler(agentMode), { localConcurrency: 4 });
  await jobs.work(
    "linear.activity.send",
    activitySendHandler({
      db: small,
      trackers,
      clock: systemClock,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
      heartbeatMs: 20 * 60_000,
    }),
    { localConcurrency: 4 },
  );
  const inbox = createWebhookInbox({
    db: small,
    jobs,
    secretStore,
    trackerVerifiers: {
      linear: new LinearAdapter({ auth: { kind: "oauth", token: "verify-only" } }),
    },
    codeHost,
    clock: systemClock,
    logger: silentLogger,
    insertDeadlineMs: 2_000,
    blocked: new Set(),
  });
  const server = createCoreServer({ routes: [inbox.handle], upgrade: () => undefined, logger: silentLogger });
  servers.push(server);
  const port = await server.listen(0, "127.0.0.1");
  inboxUrl = `http://127.0.0.1:${String(port)}/webhooks/linear/${connectionId}`;
});

afterAll(async () => {
  for (const server of servers) await server.close();
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await small.$disconnect();
  await test.dispose();
});

describe("agent mode under a burst on a small pool (F-012)", () => {
  it(
    "F-012/c1,c3: a burst bigger than the pool waits its turn: 50 delegations 250 ms apart on 3 connections are each a task, acknowledged in under 5 s with its first thought under 10 s and no job retried, and 50 answers at once, behind transactions holding every connection past Prisma's 2 s, each end their session",
    { timeout: 180_000 },
    async () => {
      // 1. The delegations, at the rehearsal's rate, through core's inbox and its queue.
      const issues = await Promise.all(
        Array.from({ length: DELEGATIONS }, (_, index) =>
          fake.createIssue({ title: `Burst ${String(index)}` }),
        ),
      );
      const timings = await Promise.all(
        issues.map(async (issue, index) => {
          await sleep(index * SPACING_MS);
          const { sessionId } = await fake.delegateToApp(issue.id, fake.admin.id);
          const event = fake
            .sessionEvents()
            .find((one) => one.sessionId === sessionId && one.action === "created");
          const deliveryId = randomUUID();
          const delivery = signed(event?.body, deliveryId);
          const sentAt = Date.now();
          const response = await fetch(inboxUrl, { method: "POST", headers: delivery.headers, body: delivery.body });
          await response.arrayBuffer();
          const ackMs = Date.now() - sentAt;
          const answeredAt = Date.now();
          const posted = await until(() => (fake.session(sessionId)?.activities.length ?? 0) > 0, 20_000);
          return {
            sessionId,
            deliveryId,
            status: response.status,
            ackMs,
            firstThoughtMs: posted ? Date.now() - answeredAt : Number.POSITIVE_INFINITY,
          };
        }),
      );
      expect(timings.map((one) => one.status)).toEqual(timings.map(() => 200));
      expect(Math.max(...timings.map((one) => one.ackMs))).toBeLessThan(5_000);
      expect(Math.max(...timings.map((one) => one.firstThoughtMs))).toBeLessThan(10_000);
      for (const one of timings) {
        expect(fake.session(one.sessionId)?.activities[0]).toMatchObject({ type: "thought" });
      }
      // Each job ran once: none went back to the queue for a transaction it couldn't start.
      const runs = await Promise.all(
        timings.map((one) =>
          jobs.find("linear.agent-event", {
            organizationId,
            connectionId,
            deliveryId: webhookDeliveryIdSchema.parse(one.deliveryId),
          }),
        ),
      );
      expect(runs.flat().map((job) => job.retryCount)).toEqual(timings.map(() => 0));
      const sessions = await test.db.agentSession.findMany({
        where: { connectionId, externalSessionId: { in: timings.map((one) => one.sessionId) } },
        select: { id: true, taskId: true, state: true },
      });
      expect(sessions).toHaveLength(DELEGATIONS);
      expect(sessions.every((session) => session.taskId !== null && session.state === "awaiting_approval")).toBe(true);

      // 2. One member's answer to each at once, while long transactions hold every connection
      //    for longer than Prisma's own wait: each answer waits its turn, and none is lost.
      const scope: MemberScope = {
        organizationId,
        memberId: memberIdSchema.parse(fixture.a.member.id),
        role: "member",
        projectRoles: new Map(),
      };
      const ports: Ports = {
        jobs,
        outbox: postgresCommandOutbox,
        notices: postgresChangeNotices,
        audit: postgresAuditLog,
        clock: systemClock,
        adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
      };
      const holds = Array.from({ length: POOL }, () =>
        small.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_sleep(${HOLD_MS / 1_000})`;
          },
          { timeout: HOLD_MS + 10_000 },
        ),
      );
      // Every connection is taken before the answers come.
      expect(
        await until(async () => {
          const rows = await test.db.$queryRaw<readonly { readonly n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND query LIKE 'SELECT pg_sleep%' AND state = 'active'`;
          return (rows[0]?.n ?? 0) === POOL;
        }, 5_000),
      ).toBe(true);
      const answers = await Promise.all(
        sessions.map((session) =>
          rejectOutsideTask({ db: small, ...ports, publicUrl: PUBLIC_URL }, scope, {
            taskId: taskIdSchema.parse(session.taskId),
            reason: null,
          }),
        ),
      );
      await Promise.all(holds);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(DELEGATIONS);
      // Each session ended with one final response, posted by the outbox.
      expect(
        await until(
          async () =>
            (await test.db.agentActivity.count({
              where: { agentSessionId: { in: sessions.map((session) => session.id) }, kind: "response", state: "sent" },
            })) === DELEGATIONS,
          60_000,
        ),
      ).toBe(true);
      expect(
        await test.db.agentSession.count({
          where: { id: { in: sessions.map((session) => session.id) }, state: "ended" },
        }),
      ).toBe(DELEGATIONS);
      for (const one of timings) {
        expect(fake.session(one.sessionId)?.activities.filter((activity) => activity.type === "response")).toHaveLength(1);
      }
    },
  );

  it(
    "F-012/c1: a delegation whose ticket its own webhook is copying at that moment takes that copy and starts its task on the first try",
    { timeout: 60_000 },
    async () => {
      // A delegation's `created` and its ticket's `Issue` webhook come together: the hint's ingest
      // writes the ticket's copy first and is still committing when the delegation reads the ticket.
      const issue = await fake.createIssue({ title: "Copied twice at once" });
      const { sessionId } = await fake.delegateToApp(issue.id, fake.admin.id);
      const body = fake.sessionEvents().find((one) => one.sessionId === sessionId && one.action === "created")?.body;
      const lookup = await trackers.forConnection(organizationId, connectionId);
      if (!lookup.ok) throw new Error(lookup.message);
      const tracker = lookup.value.tracker;
      const event = tracker.parseAgentSessionEvent(body);
      if (!event.ok) throw new Error("the session's event didn't parse");
      const read = await tracker.getTicket({ externalId: fake.team.id }, { externalId: issue.id });
      if (!read.ok) throw new Error(`the ticket's read: ${read.error.code}`);
      const board = await test.db.board.findUniqueOrThrow({
        where: { id: boardId },
        select: { id: true, organizationId: true, projectId: true, connectionId: true, externalId: true },
      });
      let written = (): void => undefined;
      const copied = new Promise<void>((resolve) => {
        written = resolve;
      });
      const hint = test.db.$transaction(
        async (tx) => {
          await upsertTicketCacheInTx(tx, [board], read.value);
          written();
          await tx.$executeRaw`SELECT pg_sleep(2)`;
        },
        { timeout: 15_000 },
      );
      await copied;
      const outcome = await handleAgentSessionEvent(agentMode, tracker, {
        organizationId,
        connectionId,
        deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
        event: event.value,
      });
      await hint;
      expect(outcome).toMatchObject({ posted: ["waiting-for-approval"] });
      const copies = await test.db.ticket.findMany({ where: { boardId, externalId: issue.id }, select: { id: true } });
      expect(copies).toHaveLength(1);
      const session = await test.db.agentSession.findUniqueOrThrow({
        where: { connectionId_externalSessionId: { connectionId, externalSessionId: sessionId } },
        select: { ticketId: true, taskId: true },
      });
      expect(session.taskId).not.toBeNull();
      expect(session).toEqual({ ticketId: copies[0]?.id, taskId: outcome.taskId });
    },
  );
});
