import { randomUUID } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { refreshToken as refreshLinearToken } from "@ostra/adapter-linear";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createFakeLinear, manualClock } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, FakeLinearApp, ManualClock } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  authorizeLinear,
  createLinearAuthorizeUrl,
  dispatchTask,
  enableAgentMode,
  moveTaskInTx,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  setBoardAgentMode,
  stopTask,
  systemClock,
} from "@ostra/domain";
import type { Clock, LinearAppKit, MemberScope, ProjectRole } from "@ostra/domain";
import { mapTask } from "@ostra/db";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  agentActivityIdSchema,
  boardIdSchema,
  connectionIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  sessionIdSchema,
  taskIdSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyOfferResultsInTx } from "../../dispatch/dispatcher.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../../testing/fake-adapters.ts";
import { mappingFor, seedBoard } from "../../testing/tickets.ts";
import { jobContext } from "../../testing/turns.ts";
import { seedOnlineRunner, seedWorld } from "../../testing/world.ts";
import { createConnectionTrackers } from "../../tracker/connections.ts";
import type { ConnectionTrackers } from "../../tracker/connections.ts";
import { refreshConnectionToken } from "../../tracker/refresh-token.ts";
import { toPayload } from "../../webhooks/inbox.ts";
import { agentEventHandler } from "./events.ts";
import type { AgentModeDeps } from "./events.ts";
import { activitySendHandler, sendHeartbeats } from "./outbox.ts";

// Milestone 6's ticket 13 (F-012): Linear agent mode's job, outbox and heartbeat, run against the
// fake Linear server (`@ostra/adapter-sdk/testing`) and Postgres. Each case makes its session in the
// fake (a delegation, a follow-up, a stop), stores the event as the inbox would, and runs the job's
// handler; the outbox's sends run through `linear.activity.send`'s handler, and what Linear holds is
// read from the fake. The fast lane through the webhook inbox is `agent-mode.fast-lane.test.ts`.

const PUBLIC_URL = "https://ostra.example";
const HEARTBEAT_MS = 20 * 60_000;
const AGENT_SCOPES = [
  "read",
  "write",
  "issues:create",
  "comments:create",
  "app:assignable",
  "app:mentionable",
];

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let fake: FakeLinear;
let app: FakeLinearApp;
let organizationId: OrganizationId;
let projectId: ProjectId;
let connectionId: ConnectionId;
let boardId: BoardId;
let trackers: ConnectionTrackers;
let matchedUserId: string;
let outsideUserId: string;
const secretStore = new FakeSecretStore();
const codeHost = new FakeCodeHost();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
/** Every `postAgentActivity` the adapter was asked for. */
const calls: { readonly sessionId: string; readonly kind: string; readonly key: string }[] = [];

/** The shipped adapter, its `postAgentActivity` calls recorded. */
const recorded = (adapter: LinearAdapter): LinearAdapter => {
  const post = adapter.postAgentActivity.bind(adapter);
  adapter.postAgentActivity = (sessionId, activity) => {
    calls.push({ sessionId, kind: activity.kind, key: activity.idempotencyKey });
    return post(sessionId, activity);
  };
  return adapter;
};

const agentDeps = (
  clock: Clock = systemClock,
  overrides: Partial<AgentModeDeps> = {},
): AgentModeDeps => ({
  db: test.db,
  jobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock,
  trackers,
  publicUrl: PUBLIC_URL,
  logger,
  heartbeatMs: HEARTBEAT_MS,
  ...overrides,
});

const scopeOf = (
  member: SeededMember,
  role: "admin" | "member",
  projectRoles: ReadonlyMap<ProjectId, ProjectRole> = new Map(),
): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles,
});

/** Stores a session event as the inbox does, and runs `linear.agent-event` on it. */
const deliver = async (body: unknown, clock: Clock = systemClock): Promise<void> => {
  const deliveryId = webhookDeliveryIdSchema.parse(randomUUID());
  const json = toPayload(body);
  if (json === null) throw new Error("not a JSON body");
  await test.db.webhookDelivery.create({
    data: { organizationId, connectionId, deliveryId, event: "AgentSessionEvent.x", payload: json },
  });
  await agentEventHandler(agentDeps(clock))(
    jobContext("linear.agent-event", { organizationId, connectionId, deliveryId }, silentLogger),
  );
};

const lastEventBody = (): unknown => fake.sessionEvents().at(-1)?.body;

/** A new issue in the team, delegated to the app by `byUserId`: the session's `created`, acted on. */
const delegate = async (
  byUserId: string,
  clock: Clock = systemClock,
): Promise<{ readonly sessionId: string; readonly issueId: string }> => {
  const issue = await fake.createIssue({
    title: `Make the footer faster ${randomUUID().slice(0, 4)}`,
  });
  const { sessionId } = await fake.delegateToApp(issue.id, byUserId);
  await deliver(lastEventBody(), clock);
  return { sessionId, issueId: issue.id };
};

const sessionRow = (externalSessionId: string) =>
  test.db.agentSession.findUniqueOrThrow({
    where: { connectionId_externalSessionId: { connectionId, externalSessionId } },
  });

/** Runs `linear.activity.send` on every pending activity, as the queue would. */
const sendPending = async (clock: Clock = systemClock): Promise<number> => {
  const pending = await test.db.agentActivity.findMany({
    where: { organizationId, state: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  for (const { id } of pending) {
    await activitySendHandler({
      db: test.db,
      trackers,
      clock,
      publicUrl: PUBLIC_URL,
      logger,
      heartbeatMs: HEARTBEAT_MS,
    })(
      jobContext(
        "linear.activity.send",
        { organizationId, agentActivityId: agentActivityIdSchema.parse(id) },
        silentLogger,
      ),
    ).catch(() => undefined);
  }
  return pending.length;
};

/** What the fake Linear holds for a session: each activity's type, in order. */
const linearActivities = (sessionId: string): readonly string[] =>
  fake.session(sessionId)?.activities.map((activity) => activity.type) ?? [];

/** Leases the task to a personal runner of the member, and starts its turn: it's running. */
const running = async (taskId: TaskId, member: SeededMember) => {
  const runner = await seedOnlineRunner(test.db, organizationId, {
    kind: "personal",
    memberId: member.id,
  });
  await test.db.task.update({
    where: { id: taskId },
    data: { prompt: "The rendered ticket.", runnerId: runner.runnerId },
  });
  const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const session = await test.db.session.findFirstOrThrow({ where: { taskId, state: "starting" } });
  const offered = await test.db.$transaction((tx) =>
    dispatchTask(
      {
        tx,
        jobs,
        outbox: postgresCommandOutbox,
        notices: postgresChangeNotices,
        clock: systemClock,
      },
      {
        organizationId,
        taskId,
        sessionId: sessionIdSchema.parse(session.id),
        leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1),
      },
    ),
  );
  if (!offered.ok) throw new Error(`dispatch: ${offered.message}`);
  const command = await test.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  await test.db.$transaction((tx) =>
    applyOfferResultsInTx(
      { jobs, notices: postgresChangeNotices, clock: systemClock, logger: silentLogger },
      tx,
      runner,
      [
        {
          commandId: offered.commandId,
          seq: command.seq,
          kind: "dispatch",
          body: command.body,
          taskId,
          result: "accepted",
          reason: null,
        },
      ],
    ),
  );
  await test.db.$transaction(async (tx) => {
    const row = mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } }));
    await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, row, { type: "box_ready" });
  });
  return runner;
};

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
  const refresh = await secretStore.put(
    { organizationId, purpose: "linear-refresh-token" },
    token.refreshToken,
  );
  const clientSecret = await secretStore.put(
    { organizationId, purpose: "linear-client-secret" },
    app.clientSecret,
  );
  if (!access.ok || !refresh.ok || !clientSecret.ok)
    throw new Error("the fake secret store refused");
  const row = await test.db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: app.clientId,
      state: "active",
      webhookMode: "webhooks",
      credentialKind: "app_oauth",
      accessTokenSecretRef: access.value,
      refreshTokenSecretRef: refresh.value,
      clientSecretSecretRef: clientSecret.value,
      accessTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000),
      appUserId: fake.appUser()?.id ?? null,
      scopes: AGENT_SCOPES,
      agentModeAt: new Date(),
    },
  });
  connectionId = connectionIdSchema.parse(row.id);
  trackers = createConnectionTrackers({
    db: test.db,
    secretStore,
    clock: systemClock,
    logger: silentLogger,
    build: (input) =>
      input.kind === "linear"
        ? recorded(
            new LinearAdapter(
              {
                apiUrl: fake.apiUrl,
                auth:
                  input.credentialKind === "api_key"
                    ? { kind: "api-key", token: input.token }
                    : { kind: "oauth", token: input.token },
              },
              input.context,
            ),
          )
        : null,
  });
  const statuses = await new LinearAdapter({
    apiUrl: fake.apiUrl,
    auth: { kind: "oauth", token: token.accessToken },
  }).listStatuses({ externalId: fake.team.id });
  if (!statuses.ok) throw new Error(statuses.error.message);
  boardId = await seedBoard(test.db, {
    organizationId,
    projectId,
    connectionId,
    externalId: fake.team.id,
    key: "OST",
    mapping: mappingFor(statuses.value, "ostra"),
  });
  await test.db.board.update({ where: { id: boardId }, data: { agentMode: true } });
  // A member's address in Linear, and a person from outside.
  const memberUser = await test.db.user.findUniqueOrThrow({
    where: { id: fixture.a.member.userId },
  });
  matchedUserId = fake.addUser({ name: "Mia Member", email: memberUser.email.toUpperCase() }).id;
  outsideUserId = fake.addUser({ name: "Olly Outside", email: "olly@outside.example" }).id;
});

afterAll(async () => {
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("a delegation (F-012)", () => {
  it("F-012/c1: a delegation from a matched member starts their task, with its first thought in the outbox in the same transaction, and no runner waited for", async () => {
    const { sessionId } = await delegate(matchedUserId);
    const session = await sessionRow(sessionId);
    expect(session).toMatchObject({
      state: "active",
      projectId,
      boardId,
      matchedMemberId: fixture.a.member.id,
    });
    const task = await test.db.task.findUniqueOrThrow({ where: { id: session.taskId ?? "" } });
    expect(task).toMatchObject({
      state: "queued",
      creatorMemberId: fixture.a.member.id,
      origin: "tracker",
      poolOnly: false,
    });
    const [first] = await test.db.agentActivity.findMany({ where: { agentSessionId: session.id } });
    // Written with the session in one transaction, and posted at once: the job doesn't wait for the queue.
    expect(first).toMatchObject({ kind: "thought", state: "sent" });
    expect(first?.body).toContain(`${PUBLIC_URL}/tasks/${task.id}`);
    expect(await sendPending()).toBe(0);
    expect(linearActivities(sessionId)).toEqual(["thought"]);
    const event = await test.db.event.findFirst({
      where: { taskId: task.id, kind: "tracker.session_event" },
    });
    expect(event?.payload).toMatchObject({
      action: "created",
      byName: "Mia Member",
      matchedMemberId: fixture.a.member.id,
    });
  });

  it("F-012/c1: a replayed created, under another delivery, starts one task and posts one thought", async () => {
    const { sessionId } = await delegate(matchedUserId);
    const created = fake
      .sessionEvents()
      .filter((event) => event.sessionId === sessionId && event.action === "created");
    await deliver(created[0]?.body);
    await deliver(created[0]?.body);
    const session = await sessionRow(sessionId);
    expect(await test.db.task.count({ where: { id: session.taskId ?? "" } })).toBe(1);
    expect(
      await test.db.agentSession.count({ where: { connectionId, externalSessionId: sessionId } }),
    ).toBe(1);
    expect(await test.db.agentActivity.count({ where: { agentSessionId: session.id } })).toBe(1);
  });

  it("F-012/c1: a delegation from outside waits for approval, and the team with no agent-mode board gets an error, and the session ends", async () => {
    const { sessionId } = await delegate(outsideUserId);
    const outside = await sessionRow(sessionId);
    expect(outside).toMatchObject({ state: "awaiting_approval", matchedMemberId: null });
    expect(
      await test.db.task.findUniqueOrThrow({ where: { id: outside.taskId ?? "" } }),
    ).toMatchObject({ state: "awaiting_approval", poolOnly: true });
    const team = fake.addTeam("OPS", "Operations");
    const issue = await fake.createIssue({ teamId: team.id, title: "Nobody takes this team" });
    const { sessionId: lonely } = await fake.delegateToApp(issue.id, matchedUserId);
    await deliver(lastEventBody());
    const row = await sessionRow(lonely);
    expect(row).toMatchObject({ state: "ended", taskId: null, projectId: null });
    await sendPending();
    expect(linearActivities(lonely)).toEqual(["error"]);
  });
});

describe("prompted: a stop and a follow-up (F-012)", () => {
  it("F-012/c2,c3: a stop from Linear stops the turn through the lease's runner, posts one final response, and nothing after it", async () => {
    const { sessionId } = await delegate(matchedUserId);
    const taskId = taskIdSchema.parse((await sessionRow(sessionId)).taskId);
    const runner = await running(taskId, fixture.a.member);
    await sendPending();
    // A post still waiting when the stop comes would land after the final word: it's dropped.
    await test.db.$transaction(async (tx) => {
      const row = mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } }));
      await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, row, {
        type: "needs_you",
        reason: "question",
      });
    });
    await fake.promptSession(sessionId, "", { stop: true, byUserId: outsideUserId });
    await deliver(lastEventBody());
    // The stop is in Postgres: the task is stopped, and the stop command waits for the runner
    // holding the lease, whichever replica it's connected to. This job ran on no gateway at all.
    expect(await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      state: "stopped",
      stoppedReason: "requested",
    });
    const stop = await test.db.command.findFirst({ where: { taskId, kind: "stop" } });
    expect(stop).toMatchObject({ runnerId: runner.runnerId });
    expect((await sessionRow(sessionId)).state).toBe("ended");
    // The audit names the Linear user who pressed stop.
    const audit = await test.db.auditEntry.findFirst({
      where: { entityId: taskId, action: "task.stopped" },
    });
    expect(audit?.data).toMatchObject({ via: "linear", trackerUser: "Olly Outside" });
    // The same stop again, and a PR opening after, post nothing more.
    await deliver(lastEventBody());
    await test.db.$transaction(async (tx) => {
      const row = mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } }));
      await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, row, { type: "reopen" });
    });
    await sendPending();
    const types = linearActivities(sessionId);
    expect(types.filter((type) => type === "response")).toHaveLength(1);
    expect(types.at(-1)).toBe("response");
    expect(types).not.toContain("elicitation");
  });

  it("F-012/c2: a follow-up from a matched member reaches the next turn as their message; from someone outside, nothing reaches the agent", async () => {
    const { sessionId } = await delegate(matchedUserId);
    const taskId = taskIdSchema.parse((await sessionRow(sessionId)).taskId);
    await running(taskId, fixture.a.member);
    await fake.promptSession(sessionId, "Also make the header faster", { byUserId: matchedUserId });
    await deliver(lastEventBody());
    const message = await test.db.event.findFirst({ where: { taskId, kind: "user.message" } });
    expect(message?.payload).toMatchObject({
      memberId: fixture.a.member.id,
      intent: "linear-follow-up",
      delivery: "queued",
      text: "Also make the header faster",
    });
    const steers = await test.db.command.findMany({ where: { taskId, kind: "steer" } });
    expect(steers).toHaveLength(1);
    expect(steers[0]?.body).toMatchObject({ delivery: "queue", intent: "linear-follow-up" });

    await fake.promptSession(sessionId, "Delete the database", { byUserId: outsideUserId });
    await deliver(lastEventBody());
    expect(await test.db.command.count({ where: { taskId, kind: "steer" } })).toBe(1);
    expect(await test.db.event.count({ where: { taskId, kind: "user.message" } })).toBe(1);
    await sendPending();
    const bodies = fake.session(sessionId)?.activities.map((activity) => activity.body ?? "") ?? [];
    expect(
      bodies.some((body) => body.startsWith("Only members of the project can steer this task")),
    ).toBe(true);
    // The prompt's text reached no log line.
    expect(JSON.stringify(records)).not.toContain("Delete the database");
    expect(JSON.stringify(records)).not.toContain("Also make the header faster");
  });
});

describe("the outbox and the heartbeat (F-012)", () => {
  /** A session made at the clock's time, its first post sent then. */
  const quietSession = async (clock: ManualClock) => {
    const { sessionId } = await delegate(matchedUserId, clock);
    await sendPending(clock);
    return sessionRow(sessionId);
  };

  it("F-012/c3: the heartbeat comes after 20 silent minutes, and none while posts flow", async () => {
    const clock = manualClock(Date.now());
    const session = await quietSession(clock);
    expect(session.heartbeatDueAt?.getTime()).toBe(clock.now() + HEARTBEAT_MS);
    const heartbeats = () =>
      test.db.agentActivity.count({
        where: { agentSessionId: session.id, idempotencyKey: { startsWith: "heartbeat:" } },
      });
    const sweep = () =>
      sendHeartbeats({
        db: test.db,
        jobs,
        clock,
        heartbeatMs: HEARTBEAT_MS,
        heartbeatKind: "ephemeral",
      });
    clock.advance(19 * 60_000);
    await sweep();
    expect(await heartbeats()).toBe(0);
    // A post at minute 19 moves the heartbeat on: none at minute 21.
    await test.db.$transaction(async (tx) => {
      const row = mapTask(await tx.task.findUniqueOrThrow({ where: { id: session.taskId ?? "" } }));
      await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, row, { type: "cancel" });
    });
    await sendPending(clock);
    expect((await sessionRow(session.externalSessionId)).state).toBe("ended");
    // An ended session gets no heartbeat at all; a live one, 20 minutes after its last post.
    const live = await quietSession(clock);
    clock.advance(10 * 60_000);
    await test.db.agentActivity.create({
      data: {
        organizationId,
        agentSessionId: live.id,
        kind: "thought",
        body: "A post.",
        idempotencyKey: `test:${randomUUID()}`,
      },
    });
    await sendPending(clock);
    clock.advance(11 * 60_000);
    await sweep();
    expect(
      await test.db.agentActivity.count({
        where: { agentSessionId: live.id, idempotencyKey: { startsWith: "heartbeat:" } },
      }),
    ).toBe(0);
    clock.advance(10 * 60_000);
    await sweep();
    await sweep();
    expect(
      await test.db.agentActivity.count({
        where: { agentSessionId: live.id, idempotencyKey: { startsWith: "heartbeat:" } },
      }),
    ).toBe(1);
    await sendPending(clock);
    const view = fake.session(live.externalSessionId);
    expect(view?.activities.at(-1)).toMatchObject({
      type: "thought",
      ephemeral: true,
      body: "Still working on it.",
    });
    expect(await heartbeats()).toBe(0);
  });

  it("F-012/c3: OSTRA_LINEAR_HEARTBEAT_KIND=thought posts a plain thought, and a heartbeat that keeps failing is given up after 5 minutes", async () => {
    const clock = manualClock(Date.now());
    const session = await quietSession(clock);
    clock.advance(HEARTBEAT_MS + 1);
    await sendHeartbeats({
      db: test.db,
      jobs,
      clock,
      heartbeatMs: HEARTBEAT_MS,
      heartbeatKind: "thought",
    });
    const beat = await test.db.agentActivity.findFirstOrThrow({
      where: { agentSessionId: session.id, idempotencyKey: { startsWith: "heartbeat:" } },
    });
    expect(beat).toMatchObject({ kind: "thought", ephemeral: false });
    clock.advance(5 * 60_000 + 1);
    await sendPending(clock);
    expect((await test.db.agentActivity.findUniqueOrThrow({ where: { id: beat.id } })).state).toBe(
      "failed",
    );
    expect(fake.session(session.externalSessionId)?.activities).toHaveLength(1);
  });

  it("F-012/c4: no activity is ever posted with a personal key: the sender refuses the connection, and Linear refuses the key", async () => {
    const { sessionId } = await delegate(matchedUserId);
    const row = await sessionRow(sessionId);
    expect(linearActivities(sessionId)).toEqual(["thought"]);
    // The connection now holds a person's API key: the task's next moment is never posted with it.
    await test.db.connection.update({
      where: { id: connectionId },
      data: { credentialKind: "api_key" },
    });
    try {
      await test.db.$transaction(async (tx) => {
        const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: row.taskId ?? "" } }));
        await moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, task, { type: "cancel" });
      });
      await sendPending();
    } finally {
      await test.db.connection.update({
        where: { id: connectionId },
        data: { credentialKind: "app_oauth" },
      });
    }
    expect(
      await test.db.agentActivity.findMany({
        where: { agentSessionId: row.id },
        orderBy: { createdAt: "asc" },
        select: { state: true, kind: true },
      }),
    ).toEqual([
      { state: "sent", kind: "thought" },
      { state: "failed", kind: "response" },
    ]);
    expect(linearActivities(sessionId)).toEqual(["thought"]);
    // And the key itself can't: the fake Linear answers a personal key's activity 403, as Linear does.
    const personal = new LinearAdapter({
      apiUrl: fake.apiUrl,
      auth: { kind: "api-key", token: fake.adminApiKey },
    });
    const refused = await personal.postAgentActivity(sessionId, {
      kind: "thought",
      body: "From a key",
      ephemeral: false,
      idempotencyKey: "k",
    });
    expect(refused.ok ? null : refused.error.code).toBe("unauthorized");
    expect(linearActivities(sessionId)).toEqual(["thought"]);
  });

  it("F-012/c2,c4: a stop pressed in ostra's panel posts the final response with the app's token", async () => {
    const before = calls.length;
    const { sessionId } = await delegate(matchedUserId);
    const taskId = taskIdSchema.parse((await sessionRow(sessionId)).taskId);
    await sendPending();
    const stopped = await test.db.$transaction((tx) =>
      stopTask(
        {
          tx,
          scope: scopeOf(fixture.a.member, "member"),
          outbox: postgresCommandOutbox,
          notices: postgresChangeNotices,
          audit: postgresAuditLog,
          clock: systemClock,
          jobs,
        },
        { taskId },
      ),
    );
    expect(stopped.ok).toBe(true);
    await sendPending();
    expect(linearActivities(sessionId)).toEqual(["thought", "response"]);
    expect(fake.session(sessionId)?.activities.at(-1)?.body).toContain(
      `${PUBLIC_URL}/tasks/${taskId}`,
    );
    expect((await sessionRow(sessionId)).state).toBe("ended");
    // Posted by the app: the fake refuses any other principal, and the connection's token is the app's.
    expect(calls.slice(before).map((call) => call.kind)).toEqual(["thought", "response"]);
    expect(
      (await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).credentialKind,
    ).toBe("app_oauth");
  });
});

describe("turning agent mode on (F-012)", () => {
  /** The panel's Linear kit over the fake: consent with the scopes the test grants. */
  const kit = (granted: readonly string[] | null): LinearAppKit => ({
    scopes: ["read", "write", "issues:create", "comments:create"],
    webhookEvents: [],
    checkPublicUrl: () => ({ public: true }),
    manifestUrl: () => "https://linear.example/manifest",
    authorizeUrl: (input) => {
      const url = new URL("https://linear.example/oauth/authorize");
      url.searchParams.set("scope", input.scopes.join(","));
      url.searchParams.set("state", input.state);
      if (input.updateExistingToken === true)
        url.searchParams.set("update_scopes_on_existing_token", "true");
      return url.toString();
    },
    exchangeCode: () =>
      Promise.resolve({
        ok: true,
        value: {
          accessToken: `tok-${randomUUID()}`,
          refreshToken: `ref-${randomUUID()}`,
          expiresAt: Date.now() + 86_400_000,
          ...(granted === null ? {} : { scopes: granted }),
        },
      }),
    checkAppToken: () =>
      Promise.resolve({
        ok: true,
        value: {
          appUserId: "app-user",
          appUserName: "ostra",
          workspaceId: "w",
          workspaceKey: "ostra-test",
          workspaceName: "ostra-test",
        },
      }),
    revokeToken: () => Promise.resolve({ ok: true, value: null }),
  });

  const authorizeDeps = (scope: MemberScope, granted: readonly string[] | null) => ({
    scope,
    authSessionId: "panel-session",
    corePublicUrl: PUBLIC_URL,
    publicUrl: PUBLIC_URL,
    linear: kit(granted),
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { secretStore, codeHost, modelProvider: new FakeModelProvider() },
  });

  const consent = async (scope: MemberScope, granted: readonly string[] | null) => {
    const made = await test.db.$transaction((tx) =>
      createLinearAuthorizeUrl(
        { tx, ...authorizeDeps(scope, granted) },
        { connectionId },
        { agentMode: true },
      ),
    );
    if (!made.ok) return made;
    const state = new URL(made.authorizeUrl).searchParams.get("state") ?? "";
    return authorizeLinear(
      { db: test.db, ...authorizeDeps(scope, granted) },
      { code: "code-from-linear", state },
    );
  };

  it("F-012/c3: the install route is refused without an admin session; the consent asks for agent mode's scopes on the existing install; a token without them is refused", async () => {
    const admin = scopeOf(fixture.a.admin, "admin");
    const member = scopeOf(fixture.a.member, "member");
    const refused = await test.db.$transaction((tx) =>
      createLinearAuthorizeUrl(
        { tx, ...authorizeDeps(member, null) },
        { connectionId },
        { agentMode: true },
      ),
    );
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      await enableAgentMode(
        {
          db: test.db,
          jobs,
          outbox: postgresCommandOutbox,
          notices: postgresChangeNotices,
          audit: postgresAuditLog,
          clock: systemClock,
          adapters: { secretStore, codeHost, modelProvider: new FakeModelProvider() },
        },
        member,
        { connectionId },
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });

    const made = await test.db.$transaction((tx) =>
      createLinearAuthorizeUrl(
        { tx, ...authorizeDeps(admin, null) },
        { connectionId },
        { agentMode: true },
      ),
    );
    if (!made.ok) throw new Error(made.message);
    const url = new URL(made.authorizeUrl);
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      expect.arrayContaining(["app:assignable", "app:mentionable", "read", "write"]),
    );
    expect(url.searchParams.get("update_scopes_on_existing_token")).toBe("true");

    await test.db.connection.update({
      where: { id: connectionId },
      data: { agentModeAt: null, scopes: [] },
    });
    try {
      const before = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(await consent(admin, ["read", "write"])).toMatchObject({
        ok: false,
        error: "missing-scopes",
      });
      expect(await consent(admin, null)).toMatchObject({ ok: false, error: "missing-scopes" });
      const unchanged = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(unchanged).toMatchObject({
        agentModeAt: null,
        accessTokenSecretRef: before.accessTokenSecretRef,
      });
      expect(await consent(admin, AGENT_SCOPES)).toMatchObject({ ok: true });
      const on = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(on.agentModeAt).not.toBeNull();
      expect(on.scopes).toEqual(AGENT_SCOPES);
      expect(
        await test.db.auditEntry.count({
          where: { entityId: connectionId, action: "linear.agent-mode-enabled" },
        }),
      ).toBe(1);
    } finally {
      // The cases after this one use the fake's own token again.
      const token = fake.mintToken("app", AGENT_SCOPES);
      const access = await secretStore.put(
        { organizationId, purpose: "linear-access-token" },
        token.accessToken,
      );
      const refresh = await secretStore.put(
        { organizationId, purpose: "linear-refresh-token" },
        token.refreshToken,
      );
      if (access.ok && refresh.ok) {
        await test.db.connection.update({
          where: { id: connectionId },
          data: {
            accessTokenSecretRef: access.value,
            refreshTokenSecretRef: refresh.value,
            state: "active",
            scopes: AGENT_SCOPES,
          },
        });
      }
      trackers.forget(connectionId);
    }
  });

  it('F-012/c3: "Start from Linear" is a project admin\'s switch, on one board per team', async () => {
    const deps = {
      db: test.db,
      jobs,
      outbox: postgresCommandOutbox,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      adapters: { secretStore, codeHost, modelProvider: new FakeModelProvider() },
    };
    const restricted = fixture.a.restrictedProject.id;
    const other = boardIdSchema.parse(
      await seedBoard(test.db, {
        organizationId,
        projectId: restricted,
        connectionId,
        externalId: fake.team.id,
        key: "OST",
        mapping: null,
      }),
    );
    expect(
      await setBoardAgentMode(deps, scopeOf(fixture.a.member, "member"), {
        boardId: other,
        on: true,
      }),
    ).toMatchObject({ ok: false, error: "not-found" });
    expect(
      await setBoardAgentMode(
        deps,
        scopeOf(fixture.a.insider, "member", new Map([[restricted, "member"]])),
        { boardId: other, on: true },
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });
    const projectAdmin = scopeOf(fixture.a.insider, "member", new Map([[restricted, "admin"]]));
    const taken = await setBoardAgentMode(deps, projectAdmin, { boardId: other, on: true });
    expect(taken).toMatchObject({ ok: false, error: "team-taken" });
    expect(taken.ok ? "" : taken.message).toContain(fixture.a.openProject.name);
    // The index holds it too, whatever the use case reads.
    await expect(
      test.db.board.update({ where: { id: other }, data: { agentMode: true } }),
    ).rejects.toThrow();
    await test.db.board.update({ where: { id: boardId }, data: { agentMode: false } });
    try {
      expect(
        await setBoardAgentMode(deps, projectAdmin, { boardId: other, on: true }),
      ).toMatchObject({ ok: true, on: true });
      expect(
        await test.db.auditEntry.count({
          where: { entityId: restricted, action: "board.agent-mode-changed" },
        }),
      ).toBe(1);
      expect(
        await setBoardAgentMode(deps, projectAdmin, { boardId: other, on: false }),
      ).toMatchObject({ ok: true, on: false });
    } finally {
      await test.db.board.update({ where: { id: boardId }, data: { agentMode: true } });
    }
  });

  it("F-012/c5: the app's token is refreshed with its rotating refresh token, and a refresh whose answer was lost is retried within Linear's window", async () => {
    const refreshDeps = {
      db: test.db,
      jobs,
      secretStore,
      trackers,
      notices: postgresChangeNotices,
      audit: postgresAuditLog,
      clock: systemClock,
      logger,
      tokenUrl: fake.tokenUrl,
    };
    await test.db.connection.update({
      where: { id: connectionId },
      data: { accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    const before = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    // The first answer is lost on the way back: Linear rotated the pair, ostra never saw it.
    let lost = false;
    await expect(
      refreshConnectionToken(
        {
          ...refreshDeps,
          refresh: async (args) => {
            await refreshLinearToken({ ...args, tokenUrl: fake.tokenUrl });
            lost = true;
            return { ok: false, error: { code: "unavailable", message: "the answer was lost" } };
          },
        },
        { organizationId, connectionId },
      ),
    ).rejects.toThrow();
    expect(lost).toBe(true);
    expect(
      (await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).state,
    ).toBe("active");
    // The job's retry sends the same refresh token, and Linear repeats the pair.
    expect(
      (await refreshConnectionToken(refreshDeps, { organizationId, connectionId })).outcome,
    ).toBe("refreshed");
    const after = await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after.accessTokenSecretRef).not.toBe(before.accessTokenSecretRef);
    expect(after.state).toBe("active");
    // The refreshed token posts in a session.
    trackers.forget(connectionId);
    const { sessionId } = await delegate(matchedUserId);
    await sendPending();
    expect(linearActivities(sessionId)).toEqual(["thought"]);
  });
});
