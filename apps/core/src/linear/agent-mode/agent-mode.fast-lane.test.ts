import { createHmac, randomUUID } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, FakeLinearApp } from "@ostra/adapter-sdk/testing";
import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  systemClock,
} from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCoreServer } from "../../server.ts";
import type { CoreServer } from "../../server.ts";
import { FakeCodeHost, FakeSecretStore } from "../../testing/fake-adapters.ts";
import { seedBoard } from "../../testing/tickets.ts";
import { seedWorld } from "../../testing/world.ts";
import { createConnectionTrackers } from "../../tracker/connections.ts";
import { createWebhookInbox } from "../../webhooks/inbox.ts";
import { agentEventHandler } from "./events.ts";
import { activitySendHandler } from "./outbox.ts";

// Milestone 6's ticket 13 (F-012): agent mode's fast lane, end to end on one core. The fake Linear
// makes each session; its `AgentSessionEvent` goes through core's real webhook inbox (verify,
// claim, 200), and the real queue runs `linear.agent-event` and `linear.activity.send` through the
// shipped `LinearAdapter`, whose post the fake Linear records. No runner is online in this file: nothing in the lane waits for one.

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

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let fake: FakeLinear;
let app: FakeLinearApp;
let organizationId: OrganizationId;
let projectId: ProjectId;
let connectionId: ConnectionId;
const secretStore = new FakeSecretStore();
const codeHost = new FakeCodeHost();
const servers: CoreServer[] = [];

const startInbox = async (db: Db, insertDeadlineMs = 2_000): Promise<string> => {
  const inbox = createWebhookInbox({
    db,
    jobs,
    secretStore,
    trackerVerifiers: {
      linear: new LinearAdapter({ auth: { kind: "oauth", token: "verify-only" } }),
    },
    codeHost,
    clock: systemClock,
    logger: silentLogger,
    insertDeadlineMs,
    blocked: new Set(),
  });
  const server = createCoreServer({
    routes: [inbox.handle],
    upgrade: () => undefined,
    logger: silentLogger,
  });
  servers.push(server);
  const port = await server.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${String(port)}/webhooks/linear/${connectionId}`;
};

/** The session's event as Linear sends it: signed with the app's webhook secret, stamped now. */
const signed = (
  body: unknown,
  deliveryId = randomUUID(),
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

const post = async (url: string, delivery: ReturnType<typeof signed>): Promise<number> => {
  const response = await fetch(url, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  await response.arrayBuffer();
  return response.status;
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

let inboxUrl: string;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  await seedWorld(test.db, { codeHost, secretStore }, organizationId, projectId);
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
  const boardId = await seedBoard(test.db, {
    organizationId,
    projectId,
    connectionId,
    externalId: fake.team.id,
    key: "OST",
    mapping: null,
  });
  await test.db.board.update({ where: { id: boardId }, data: { agentMode: true } });
  const trackers = createConnectionTrackers({
    db: test.db,
    secretStore,
    clock: systemClock,
    logger: silentLogger,
    build: (input) =>
      input.kind === "linear"
        ? new LinearAdapter({ apiUrl: fake.apiUrl, auth: { kind: "oauth", token: input.token } }, input.context)
        : null,
  });
  await jobs.work(
    "linear.agent-event",
    agentEventHandler({
      db: test.db,
      jobs,
      outbox: postgresCommandOutbox,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      trackers,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
      heartbeatMs: 20 * 60_000,
    }),
    { localConcurrency: 4 },
  );
  await jobs.work(
    "linear.activity.send",
    activitySendHandler({
      db: test.db,
      trackers,
      clock: systemClock,
      publicUrl: PUBLIC_URL,
      logger: silentLogger,
      heartbeatMs: 20 * 60_000,
    }),
    {
      localConcurrency: 4,
    },
  );
  inboxUrl = await startInbox(test.db);
});

afterAll(async () => {
  for (const server of servers) await server.close();
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("agent mode's fast lane (F-012)", () => {
  it(
    "F-012/c1,c3: over 50 delegations with no runner online, each is acknowledged in under 5 s and its first thought posted in under 10 s",
    { timeout: 180_000 },
    async () => {
      expect(await test.db.runner.count({ where: { state: "online" } })).toBe(0);
      const issues = await Promise.all(
        Array.from({ length: DELEGATIONS }, (_, index) =>
          fake.createIssue({ title: `Delegated ${String(index)}` }),
        ),
      );
      const acks: number[] = [];
      const firsts: number[] = [];
      await Promise.all(
        issues.map(async (issue) => {
          const { sessionId } = await fake.delegateToApp(issue.id, fake.admin.id);
          const event = fake
            .sessionEvents()
            .find((one) => one.sessionId === sessionId && one.action === "created");
          const sentAt = Date.now();
          expect(await post(inboxUrl, signed(event?.body))).toBe(200);
          acks.push(Date.now() - sentAt);
          const posted = await until(
            () => (fake.session(sessionId)?.activities.length ?? 0) > 0,
            15_000,
          );
          expect(posted).toBe(true);
          firsts.push(Date.now() - sentAt);
          expect(fake.session(sessionId)?.activities[0]).toMatchObject({ type: "thought" });
        }),
      );
      expect(acks).toHaveLength(DELEGATIONS);
      expect(Math.max(...acks)).toBeLessThan(5_000);
      expect(Math.max(...firsts)).toBeLessThan(10_000);
      // Every delegation is a task, queued for a runner that isn't there.
      expect(
        await test.db.agentSession.count({ where: { connectionId, taskId: { not: null } } }),
      ).toBe(DELEGATIONS);
      expect(
        await test.db.task.count({
          where: { projectId, origin: "tracker", state: { in: ["queued", "awaiting_approval"] } },
        }),
      ).toBe(DELEGATIONS);
    },
  );

  it("F-012/c3: the claim and its job commit before the 200; an insert that fails answers non-2xx and leaves no job, and the same delivery again starts nothing", async () => {
    const issue = await fake.createIssue({ title: "Claimed first" });
    const { sessionId } = await fake.delegateToApp(issue.id, fake.admin.id);
    const body = fake.sessionEvents().find((one) => one.sessionId === sessionId)?.body;

    // The claim's insert fails: another transaction holds the table, and the insert's deadline
    // (500 ms here) cancels it. The answer isn't a 2xx, so Linear sends it again.
    const failingUrl = await startInbox(test.db, 500);
    const refusedId = randomUUID();
    let refused = 0;
    await test.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "webhook_delivery" IN EXCLUSIVE MODE`;
        refused = await post(failingUrl, signed(body, refusedId));
      },
      { timeout: 20_000 },
    );
    expect(refused).toBeGreaterThanOrEqual(500);
    const deliveryKey = {
      organizationId,
      connectionId,
      deliveryId: webhookDeliveryIdSchema.parse(refusedId),
    };
    expect(await jobs.find("linear.agent-event", deliveryKey)).toHaveLength(0);
    expect(await test.db.webhookDelivery.count({ where: { deliveryId: refusedId } })).toBe(0);

    // The sender's retry: the claim commits with its job, and both are there when the 200 arrives.
    expect(await post(inboxUrl, signed(body, refusedId))).toBe(200);
    expect(
      await test.db.webhookDelivery.count({ where: { connectionId, deliveryId: refusedId } }),
    ).toBe(1);
    expect(await jobs.find("linear.agent-event", deliveryKey)).toHaveLength(1);
    // The same delivery again is a duplicate: no second claim, no second job.
    expect(await post(inboxUrl, signed(body, refusedId))).toBe(200);
    expect(await jobs.find("linear.agent-event", deliveryKey)).toHaveLength(1);
    expect(
      await until(
        async () =>
          (await test.db.agentSession.count({
            where: { connectionId, externalSessionId: sessionId, taskId: { not: null } },
          })) === 1,
        10_000,
      ),
    ).toBe(true);
    // A replayed created under a new delivery ID: still one session and one task.
    expect(await post(inboxUrl, signed(body))).toBe(200);
    await until(
      async () =>
        (await test.db.webhookDelivery.count({ where: { connectionId, status: "received" } })) ===
        0,
      10_000,
    );
    const session = await test.db.agentSession.findUniqueOrThrow({
      where: { connectionId_externalSessionId: { connectionId, externalSessionId: sessionId } },
    });
    expect(await test.db.task.count({ where: { id: session.taskId ?? "" } })).toBe(1);
    expect(await test.db.agentActivity.count({ where: { agentSessionId: session.id } })).toBe(1);
  });
});
