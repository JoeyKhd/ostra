import { randomUUID } from "node:crypto";

import { GitHubAdapter } from "@ostra/adapter-github";
import { ModelEndpointAdapter } from "@ostra/adapter-model-endpoint";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import type { Db } from "@ostra/db";
import { HEARTBEAT_KEY_PREFIX, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, rejectOutsideTask, stopTask, systemClock } from "@ostra/domain";
import type { MemberScope, Ports } from "@ostra/domain";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, memberIdSchema, organizationIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

// ostra's side of the harness (ticket 38): what it seeds in the stack's database before Linear
// sends anything, and what it reads back. The run goes through core itself (its inbox, the claim,
// the queue, the outbox and the heartbeat); the harness only writes what an admin's setup would
// (the app's connection, "Start from Linear" on the team's board, outside approval on), answers the
// outside tasks as a project member would ("Reject"), and reads the rows core wrote. No token, ticket
// text or activity body is read into a log line.

export type OstraWorld = {
  readonly db: Db;
  /** Enqueue-only, for the member's answers. */
  readonly jobs: Jobs;
  readonly secretStore: BuiltinSecretStore;
  readonly publicUrl: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  /** The project member who answers outside tasks; phase 3 gives their account the key user's address. */
  readonly member: { readonly memberId: string; readonly userId: string };
};

/** The `secret` table as the built-in store's rows: the same rows core reads. */
export const secretRows = (db: Db): SecretRowStore => ({
  insert: async (row) => {
    await db.secret.create({
      data: { id: row.id, organizationId: row.organizationId, purpose: row.purpose, ciphertext: Uint8Array.from(row.ciphertext), nonce: Uint8Array.from(row.nonce), keyVersion: row.keyVersion },
    });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    if (row === null) return undefined;
    return { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: async (id) => (await db.secret.deleteMany({ where: { id } })).count > 0,
});

/** The store core reads, opened with the stack's key. */
export const openStore = (db: Db, secretsKey: string): BuiltinSecretStore => {
  const key = parseSecretsKey(secretsKey);
  if (!key.ok) throw new Error(`the stack's secrets key: ${key.error.message}`);
  return new BuiltinSecretStore({ rows: secretRows(db), key: key.value });
};

/** The ports a member's answer takes, as the panel builds them. */
export const memberPorts = (world: Pick<OstraWorld, "jobs" | "secretStore">): Ports => {
  const context = { logger: silentLogger, clock: adapterClock };
  return {
    jobs: world.jobs,
    outbox: postgresCommandOutbox,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: {
      codeHost: new GitHubAdapter({ userAgent: "ostra-agent-mode-harness" }, context),
      modelProvider: new ModelEndpointAdapter({ allowPrivateNetwork: true }, context),
      secretStore: world.secretStore,
    },
  };
};

export type AppConnectionInput = {
  /** The connection's ID: the last part of the app's webhook URL, `/webhooks/linear/<id>`. */
  readonly connectionId: ConnectionId | null;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly appUser: { readonly id: string; readonly name: string };
  readonly workspace: { readonly id: string; readonly key: string; readonly name: string };
};

/** The app's connection, as "Turn on agent mode" and Authorize leave it: `app_oauth`, webhooks, the agent scopes. */
export const seedAppConnection = async (world: Pick<OstraWorld, "db" | "secretStore" | "organizationId">, input: AppConnectionInput): Promise<ConnectionId> => {
  const { db, secretStore, organizationId } = world;
  const put = async (purpose: string, value: string): Promise<string> => {
    const stored = await secretStore.put({ organizationId, purpose }, value);
    if (!stored.ok) throw new Error(`the secret store refused the ${purpose}`);
    return stored.value;
  };
  const row = await db.connection.create({
    data: {
      id: input.connectionId ?? randomUUID(),
      organizationId,
      kind: "linear",
      appId: input.clientId,
      state: "active",
      credentialKind: "app_oauth",
      webhookMode: "webhooks",
      clientSecretSecretRef: await put("linear.client-secret", input.clientSecret),
      accessTokenSecretRef: await put("linear-access-token", input.accessToken),
      refreshTokenSecretRef: await put("linear.refresh-token", input.refreshToken),
      webhookSecretSecretRef: await put("linear.webhook-secret", input.webhookSecret),
      accessTokenExpiresAt: new Date(input.expiresAt),
      externalWorkspaceId: input.workspace.id,
      externalWorkspaceKey: input.workspace.key,
      externalWorkspaceName: input.workspace.name,
      appUserId: input.appUser.id,
      appUserName: input.appUser.name,
      scopes: [...input.scopes],
      agentModeAt: new Date(),
      activatedAt: new Date(),
    },
    select: { id: true },
  });
  return connectionIdSchema.parse(row.id);
};

export type TeamStates = readonly { readonly id: string; readonly name: string; readonly type: string }[];

/** "Start from Linear" on the team's board of the project, and outside approval on the project. */
export const seedAgentModeBoard = async (
  world: Pick<OstraWorld, "db" | "organizationId" | "projectId">,
  input: { readonly connectionId: ConnectionId; readonly team: { readonly id: string; readonly key: string; readonly name: string }; readonly states: TeamStates },
): Promise<string> => {
  const stateOf = (type: string, name?: string): string => input.states.find((state) => state.type === type && (name === undefined || state.name === name))?.id ?? input.states.find((state) => state.type === type)?.id ?? "";
  await world.db.project.update({ where: { id: world.projectId }, data: { outsideApproval: true } });
  const board = await world.db.board.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      connectionId: input.connectionId,
      externalId: input.team.id,
      key: input.team.key,
      name: input.team.name,
      agentMode: true,
      statusMap: {
        open: input.states.filter((state) => ["triage", "backlog", "unstarted"].includes(state.type)).map((state) => state.id),
        started: stateOf("started", "In Progress"),
        inReview: stateOf("started", "In Review"),
        done: stateOf("completed"),
        doneBy: "ostra",
        magicWord: "Closes",
      },
    },
    select: { id: true },
  });
  return board.id;
};

/** Gives the member's account the address of the key's user, so their next delegations are a member's own. */
export const matchKeyUser = async (world: Pick<OstraWorld, "db" | "member">, address: string): Promise<void> => {
  await world.db.user.update({ where: { id: world.member.userId }, data: { email: address } });
};

export const runnersOnline = (world: Pick<OstraWorld, "db" | "organizationId">): Promise<number> => world.db.runner.count({ where: { organizationId: world.organizationId, state: "online" } });

export type SessionRead = {
  readonly id: string;
  readonly externalSessionId: string;
  /** The tracker's ID of the session's ticket. */
  readonly issueId: string | null;
  readonly state: string;
  readonly taskId: string | null;
  readonly matched: boolean;
  /** When core's inbox took the session's `created` webhook (its 200 follows the insert). */
  readonly ackedAt: number | null;
  readonly firstThoughtAt: number | null;
  readonly activities: readonly { readonly kind: string; readonly heartbeat: boolean; readonly state: string; readonly createdAt: number; readonly sentAt: number | null }[];
};

const deliverySchema = z.object({ sid: z.string().nullable(), action: z.string().nullable(), signal: z.string().nullable(), received_ms: z.number() });

/** Each of the connection's `AgentSessionEvent` deliveries: the session, the action, a stop's signal and when it was taken. */
export const sessionDeliveries = async (db: Db, connectionId: ConnectionId) => {
  const rows: unknown = await db.$queryRaw`
    SELECT "payload"->'agentSession'->>'id' AS sid, "payload"->>'action' AS action,
           COALESCE("payload"->'agentActivity'->>'signal', "payload"->>'signal') AS signal,
           (extract(epoch from "receivedAt") * 1000)::float8 AS received_ms
      FROM "webhook_delivery" WHERE "connectionId" = ${connectionId} AND "payload" ? 'agentSession'`;
  return z.array(deliverySchema).parse(rows);
};

/** ostra's agent sessions on the connection, with their acks, first thoughts and posts. */
export const readSessions = async (db: Db, connectionId: ConnectionId): Promise<readonly SessionRead[]> => {
  const deliveries = await sessionDeliveries(db, connectionId);
  const sessions = await db.agentSession.findMany({
    where: { connectionId },
    orderBy: { createdAt: "asc" },
    select: { id: true, externalSessionId: true, state: true, taskId: true, matchedMemberId: true, ticket: { select: { externalId: true } }, activities: { orderBy: { createdAt: "asc" }, select: { kind: true, idempotencyKey: true, state: true, createdAt: true, sentAt: true } } },
  });
  return sessions.map((session) => {
    const created = deliveries.filter((one) => one.sid === session.externalSessionId && one.action === "created").map((one) => one.received_ms);
    const thought = session.activities.find((activity) => activity.kind === "thought" && activity.sentAt !== null && !activity.idempotencyKey.startsWith(HEARTBEAT_KEY_PREFIX));
    return {
      id: session.id,
      externalSessionId: session.externalSessionId,
      issueId: session.ticket?.externalId ?? null,
      state: session.state,
      taskId: session.taskId,
      matched: session.matchedMemberId !== null,
      ackedAt: created.length === 0 ? null : Math.min(...created),
      firstThoughtAt: thought?.sentAt?.getTime() ?? null,
      activities: session.activities.map((activity) => ({
        kind: activity.kind,
        heartbeat: activity.idempotencyKey.startsWith(HEARTBEAT_KEY_PREFIX),
        state: activity.state,
        createdAt: activity.createdAt.getTime(),
        sentAt: activity.sentAt?.getTime() ?? null,
      })),
    };
  });
};

/** A session's last word: how many final responses it got, and how many posts came after the first. */
export const endOf = (session: SessionRead): { readonly finalResponses: number; readonly postsAfterFinal: number; readonly ended: boolean } => {
  const finals = session.activities.filter((activity) => activity.kind === "response");
  const first = finals[0];
  return {
    finalResponses: finals.filter((activity) => activity.state === "sent").length,
    postsAfterFinal: first === undefined ? 0 : session.activities.filter((activity) => activity.createdAt > first.createdAt).length,
    ended: session.state === "ended",
  };
};

/** "Reject" on every waiting outside task at once, as the project's member answers them. */
export const rejectAll = async (world: OstraWorld, taskIds: readonly string[]): Promise<number> => {
  const scope: MemberScope = { organizationId: world.organizationId, memberId: memberIdSchema.parse(world.member.memberId), role: "member", projectRoles: new Map() };
  const deps = { db: world.db, ...memberPorts(world), publicUrl: world.publicUrl };
  const answers = await Promise.all(taskIds.map((taskId) => rejectOutsideTask(deps, scope, { taskId: taskIdSchema.parse(taskId), reason: null })));
  return answers.filter((answer) => answer.ok).length;
};

/** Whether a follow-up reached the task as the member's message (`user.message`, `linear-follow-up`), for its next turn. */
export const followUpReachedTask = async (db: Db, taskId: string): Promise<boolean> => {
  const rows: unknown = await db.$queryRaw`
    SELECT count(*)::int AS n FROM "event" WHERE "taskId" = ${taskId} AND "kind" = 'user.message' AND "payload"->>'clientMessageId' LIKE 'linear-%'`;
  return (z.array(z.object({ n: z.number() })).parse(rows)[0]?.n ?? 0) > 0;
};

/** "Stop" pressed in ostra's own panel by the member: the turn stops and the session gets its final response, with the app's token. */
export const stopFromPanel = async (world: OstraWorld, taskId: string): Promise<boolean> => {
  const scope: MemberScope = { organizationId: world.organizationId, memberId: memberIdSchema.parse(world.member.memberId), role: "member", projectRoles: new Map() };
  const ports = memberPorts(world);
  const stopped = await world.db.$transaction((tx) => stopTask({ tx, scope, outbox: ports.outbox, notices: ports.notices, audit: ports.audit, clock: ports.clock, jobs: ports.jobs }, { taskId: taskIdSchema.parse(taskId) }));
  return stopped.ok;
};
