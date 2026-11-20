import type { AdapterErrorCode, Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  HEARTBEAT_KEY_PREFIX,
  HEARTBEAT_RETRY_MS,
  heartbeatCopy,
  taskPageUrl,
  withTaskUrl,
} from "@ostra/domain";
import type { Clock, JobQueue } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import {
  agentActivityIdSchema,
  connectionIdSchema,
  organizationIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { AgentActivityId, OrganizationId } from "@ostra/protocol";

import type { ConnectionTrackers } from "../../tracker/connections.ts";

// Agent mode's outbox (F-012, ADR 0013, ADR 0037; milestone 6's ticket 13).
//
// `linear.activity.send` posts one `AgentActivity` with the app's own token, never a person's key
// (a personal API key can't post an agent activity, spike 5): idempotent by its key, which the
// adapter sends with it, so a retry after a lost answer finds the first post. A failure the
// tracker may get over is retried with the queue's backoff; one it won't (a refusal) marks the row
// failed. Every post sent moves the session's heartbeat on. A session's first post links the
// session to its task's page in the panel (`setAgentSessionLink`), where the tracker has the link.
//
// `linear.heartbeat`, a sweep once a minute, posts a heartbeat for each open session whose
// `heartbeatDueAt` has passed: so a session that hears nothing for OSTRA_LINEAR_HEARTBEAT_MINUTES
// gets one, and one that hears from ostra gets none. A heartbeat that fails is retried for at most
// 5 minutes: the next one replaces it anyway.
//
// Bodies are ostra's own words: never logged either way. Logs carry IDs and outcomes.

export type ActivitySendDeps = {
  readonly db: Db;
  readonly trackers: ConnectionTrackers;
  readonly clock: Clock;
  /** The panel's address, for the task links in a body (`TASK_URL_TOKEN`). */
  readonly publicUrl: string;
  readonly logger: Logger;
  /** OSTRA_LINEAR_HEARTBEAT_MINUTES, in ms. */
  readonly heartbeatMs: number;
};

/** A refusal the tracker won't get over by asking again. */
const PERMANENT: ReadonlySet<AdapterErrorCode> = new Set<AdapterErrorCode>([
  "forbidden",
  "not-found",
  "invalid-input",
  "unsupported",
  "unauthorized",
]);

const markFailed = (db: Db, id: string): Promise<unknown> =>
  db.agentActivity.updateMany({ where: { id, state: "pending" }, data: { state: "failed" } });

/**
 * Posts one activity, if it's still pending. Throws for a failure worth retrying; the queue's job
 * retries it. Agent mode's job calls it at once for a session's first post (so the first thought
 * doesn't wait for the queue's next poll), and the outbox's job, finding it sent, does nothing.
 */
export const sendActivity = async (
  deps: ActivitySendDeps,
  organizationId: OrganizationId,
  agentActivityId: AgentActivityId,
  logger: Logger,
): Promise<void> => {
  const activity = await deps.db.agentActivity.findFirst({
    where: { id: agentActivityId, organizationId },
    select: {
      id: true,
      kind: true,
      ephemeral: true,
      body: true,
      idempotencyKey: true,
      state: true,
      attempts: true,
      createdAt: true,
      agentSession: {
        select: {
          id: true,
          externalSessionId: true,
          connectionId: true,
          taskId: true,
          lastPostAt: true,
        },
      },
    },
  });
  if (activity?.state !== "pending") {
    // Sent, dropped behind a final word, or failed: never posted again.
    return;
  }
  const session = activity.agentSession;
  const connectionId = connectionIdSchema.parse(session.connectionId);
  const now = deps.clock.now();
  if (
    activity.idempotencyKey.startsWith(HEARTBEAT_KEY_PREFIX) &&
    now - activity.createdAt.getTime() > HEARTBEAT_RETRY_MS
  ) {
    await markFailed(deps.db, activity.id);
    logger.info("linear.activity.heartbeat-given-up", {
      agentSessionId: session.id,
      attempts: activity.attempts,
    });
    return;
  }
  const connection = await deps.db.connection.findFirst({
    where: { id: connectionId, organizationId },
    select: { credentialKind: true },
  });
  if (connection?.credentialKind !== "app_oauth") {
    // Only the app's own token posts in a session: a personal key never does (ADR 0013).
    await markFailed(deps.db, activity.id);
    logger.warn("linear.activity.not-the-app", {
      agentSessionId: session.id,
      credential: connection?.credentialKind ?? "none",
    });
    return;
  }
  const lookup = await deps.trackers.forConnection(organizationId, connectionId);
  if (!lookup.ok) {
    if (lookup.reason === "no-token") {
      throw new Error(lookup.message);
    }
    await markFailed(deps.db, activity.id);
    logger.warn("linear.activity.connection-unusable", {
      agentSessionId: session.id,
      reason: lookup.reason,
    });
    return;
  }
  const taskUrl =
    session.taskId === null ? null : taskPageUrl(deps.publicUrl, taskIdSchema.parse(session.taskId));
  const body = taskUrl === null ? activity.body : withTaskUrl(activity.body, taskUrl);
  const tracker = lookup.value.tracker;
  const posted = await tracker.postAgentActivity(session.externalSessionId, {
    kind: activity.kind,
    body,
    ephemeral: activity.ephemeral,
    idempotencyKey: activity.idempotencyKey,
  });
  if (!posted.ok) {
    await deps.db.agentActivity.update({
      where: { id: activity.id },
      data: { attempts: { increment: 1 } },
    });
    if (PERMANENT.has(posted.error.code)) {
      await markFailed(deps.db, activity.id);
      logger.warn("linear.activity.refused", {
        agentSessionId: session.id,
        code: posted.error.code,
      });
      return;
    }
    logger.info("linear.activity.retry", {
      agentSessionId: session.id,
      code: posted.error.code,
      attempts: activity.attempts + 1,
    });
    throw new Error(`the tracker didn't take the activity (${posted.error.code})`);
  }
  if (taskUrl !== null && session.lastPostAt === null && tracker.capabilities.agentSessionLink) {
    // The session's first post: its link to the task's page goes with it (F-012), before the post
    // is marked sent, so a link worth retrying is retried with it (the post itself, by its key,
    // isn't made twice). A refusal leaves the session unlinked and its posts flowing.
    const linked = await tracker.setAgentSessionLink(session.externalSessionId, taskUrl);
    if (!linked.ok) {
      if (!PERMANENT.has(linked.error.code)) {
        logger.info("linear.session.link-retry", {
          agentSessionId: session.id,
          code: linked.error.code,
        });
        throw new Error(`the tracker didn't link the session (${linked.error.code})`);
      }
      logger.warn("linear.session.link-refused", {
        agentSessionId: session.id,
        code: linked.error.code,
      });
    }
  }
  const sentAt = new Date(deps.clock.now());
  await deps.db.$transaction(async (tx) => {
    await tx.agentActivity.update({
      where: { id: activity.id },
      data: {
        state: "sent",
        sentAt,
        externalActivityId: posted.value.activityId.slice(0, 256),
        attempts: { increment: 1 },
      },
    });
    // Every post moves the heartbeat on: a session that hears from ostra needs no heartbeat.
    await tx.agentSession.updateMany({
      where: { id: session.id, state: { not: "ended" } },
      data: { lastPostAt: sentAt, heartbeatDueAt: new Date(sentAt.getTime() + deps.heartbeatMs) },
    });
  });
  logger.info("linear.activity.sent", { agentSessionId: session.id, kind: activity.kind });
};

export const activitySendHandler =
  (deps: ActivitySendDeps): JobHandler<"linear.activity.send"> =>
  async (context) => {
    const organizationId = organizationIdSchema.parse(context.payload.organizationId);
    const agentActivityId = agentActivityIdSchema.parse(context.payload.agentActivityId);
    await sendActivity(
      deps,
      organizationId,
      agentActivityId,
      context.logger.child({ organizationId, agentActivityId }),
    );
  };

// ---------- the heartbeat ----------

export type HeartbeatDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly clock: Clock;
  /** OSTRA_LINEAR_HEARTBEAT_MINUTES, in ms. */
  readonly heartbeatMs: number;
  /** OSTRA_LINEAR_HEARTBEAT_KIND. */
  readonly heartbeatKind: "ephemeral" | "thought";
};

/** How many sessions one sweep posts for: the rest are due again on the next minute. */
const HEARTBEAT_SWEEP_MAX = 500;

/**
 * `sendHeartbeats`: a heartbeat in the outbox for each open session that's due. The session's due
 * time moves on as it's written, so the next sweep doesn't write it again before it's sent.
 */
export const sendHeartbeats = async (deps: HeartbeatDeps): Promise<{ readonly sent: number }> => {
  const now = deps.clock.now();
  const due = await deps.db.agentSession.findMany({
    where: { state: { not: "ended" }, heartbeatDueAt: { lte: new Date(now) } },
    orderBy: { heartbeatDueAt: "asc" },
    take: HEARTBEAT_SWEEP_MAX,
    select: { id: true },
  });
  let sent = 0;
  const copy = heartbeatCopy(deps.heartbeatKind);
  for (const { id } of due) {
    const wrote = await deps.db.$transaction(async (tx) => {
      // Locked, and due still: another replica's sweep, or a post sent meanwhile, wins.
      const rows = await tx.$queryRaw<
        readonly {
          readonly organizationId: string;
          readonly connectionId: string;
          readonly heartbeatDueAt: Date | null;
          readonly state: string;
        }[]
      >`
        SELECT "organizationId", "connectionId", "heartbeatDueAt", "state" FROM "agent_session" WHERE "id" = ${id} FOR UPDATE SKIP LOCKED`;
      const [row] = rows;
      if (
        row?.heartbeatDueAt === null ||
        row === undefined ||
        row.state === "ended" ||
        row.heartbeatDueAt.getTime() > now
      ) {
        return false;
      }
      const organizationId: OrganizationId = organizationIdSchema.parse(row.organizationId);
      const created = await tx.agentActivity.createManyAndReturn({
        data: [
          {
            organizationId,
            agentSessionId: id,
            kind: copy.kind,
            ephemeral: copy.ephemeral,
            body: copy.body,
            idempotencyKey: `${HEARTBEAT_KEY_PREFIX}${id}:${String(row.heartbeatDueAt.getTime())}`,
            // The sender gives a heartbeat up 5 minutes after this, by the same clock.
            createdAt: new Date(now),
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      for (const activity of created) {
        await deps.jobs.enqueueInTx(
          tx,
          "linear.activity.send",
          { organizationId, agentActivityId: agentActivityIdSchema.parse(activity.id) },
          { group: { id: connectionIdSchema.parse(row.connectionId) } },
        );
      }
      await tx.agentSession.update({
        where: { id },
        data: { heartbeatDueAt: new Date(now + deps.heartbeatMs) },
      });
      return created.length > 0;
    });
    if (wrote) {
      sent += 1;
    }
  }
  return { sent };
};

export const heartbeatHandler =
  (deps: HeartbeatDeps): JobHandler<"linear.heartbeat"> =>
  async (context) => {
    const { sent } = await sendHeartbeats(deps);
    if (sent > 0) {
      context.logger.info("linear.heartbeat", { sent });
    }
  };

/** The minute's sweep: one a minute however many replicas run. */
export const ensureHeartbeatSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("linear.heartbeat", "every-minute", "* * * * *", {});
};
