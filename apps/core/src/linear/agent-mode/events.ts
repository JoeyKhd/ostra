import type { AgentSessionEvent, Logger, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import {
  appendServerEvent,
  boardsOnSameTeam,
  closeItemsOfEndedTaskInTx,
  sendMemberMessageInTx,
  taskFromColumns,
  taskPageUrl,
  taskToColumns,
  transitionTask,
  upsertTicketCacheInTx,
  writeMomentToSessionInTx,
} from "@ostra/domain";
import type { AgentSessionMoment, MessageFilesDeps, Ports, SessionTimers, SpendCapSettings } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import {
  agentActivityIdSchema,
  agentSessionIdSchema,
  boardIdSchema,
  clientMessageIdSchema,
  externalTicketIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
  ticketIdSchema,
} from "@ostra/protocol";
import type {
  AgentSessionId,
  ConnectionId,
  MemberId,
  OrganizationId,
  ProjectId,
  SessionId,
  TaskId,
  WebhookDeliveryId,
} from "@ostra/protocol";

import { matchStarterInTx, memberScopeInTx, startFromTrackerInTx } from "../../starts/outside.ts";
import type { ConnectionTrackers } from "../../tracker/connections.ts";
import { sendActivity } from "./outbox.ts";

// `linear.agent-event` (F-012, ADR 0013, ADR 0057; milestone 6's ticket 13): a Linear agent
// session's event, claimed by the webhook inbox before its 200 and acted on here, from the queue.
//
// `created` (a delegation or a mention): the `AgentSession` row (unique per connection, so a
// replayed `created` starts one task); the board with "Start from Linear" on for the ticket's team
// (none: an `error` activity that says so, and the session ends); the creator matched to a member
// by their address (ADR 0057); the task started, outside or not (ticket 14); and, in the same
// transaction, the first activity (a thought) in the outbox. No runner is waited for: the task is
// queued and admission does the rest.
//
// `prompted`: with `signal: "stop"`, the stop is written to the task in Postgres, and the lease's
// holder stops the turn whichever replica it's connected to (milestone 2's stop path, the command
// outbox); one final `response` is posted, and nothing after it. A follow-up from a matched member
// who can open the project is their message (`linear-follow-up`), sent after the running turn;
// from anyone else, a thought saying only members of the project can steer it, and nothing reaches
// the agent.
//
// The prompt's text is untrusted: it goes to the agent as a member's message, never into a log line.

export type AgentModeDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly trackers: ConnectionTrackers;
  /** The panel's address, for the task links ostra posts. */
  readonly publicUrl: string;
  readonly logger: Logger;
  /** `OSTRA_LINEAR_HEARTBEAT_MINUTES`, in ms: a new session's first heartbeat is due this long after it. */
  readonly heartbeatMs: number;
  readonly spendCap?: SpendCapSettings;
  readonly timers?: SessionTimers;
  /** Milestone 9 (F-148): a follow-up's files' limits and which agents take images (`coreMessageFilesDeps`); the defaults when left out. */
  readonly files?: MessageFilesDeps;
};

export type AgentEventInput = {
  readonly organizationId: OrganizationId;
  readonly connectionId: ConnectionId;
  readonly deliveryId: WebhookDeliveryId;
  readonly event: AgentSessionEvent;
};

export type AgentEventOutcome = {
  readonly agentSessionId: AgentSessionId | null;
  readonly taskId: TaskId | null;
  readonly posted: readonly AgentSessionMoment["kind"][];
  /** Why nothing was done, in words, for the delivery's row. */
  readonly ignored?: string;
};

const NAME_MAX = 200;

/** A tracker user's name as ostra keeps it: one line, never empty. */
const nameOf = (name: string): string =>
  name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || "someone";

/** The creator's address: the event's, else the tracker's user read (`getUser`). `null` when neither says. */
const addressOf = async (
  tracker: TrackerAdapter,
  creator: AgentSessionEvent["creator"],
): Promise<string | null> => {
  if (creator.email !== null && creator.email.trim() !== "") {
    return creator.email;
  }
  const user = await tracker.getUser(creator.userId);
  if (!user.ok) {
    if (user.error.code === "rate-limited" || user.error.code === "unavailable") {
      throw new Error(`the tracker couldn't read the user (${user.error.code})`);
    }
    return null;
  }
  // A deactivated person is matched to no one.
  return user.value.active ? user.value.email : null;
};

/** The task's latest ostra session: the one a server event is written under. */
const latestSessionInTx = async (tx: Tx, taskId: string): Promise<SessionId | null> => {
  const session = await tx.session.findFirst({
    where: { taskId },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return session === null ? null : sessionIdSchema.parse(session.id);
};

const sessionEventInTx = async (
  tx: Tx,
  at: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly now: number;
  },
  action: "created" | "follow-up" | "stop",
  byName: string,
  matchedMemberId: MemberId | null,
): Promise<void> => {
  const sessionId = await latestSessionInTx(tx, at.taskId);
  if (sessionId === null) {
    return;
  }
  await appendServerEvent(tx, {
    organizationId: at.organizationId,
    projectId: at.projectId,
    taskId: at.taskId,
    sessionId,
    at: at.now,
    event: { kind: "tracker.session_event", action, byName, matchedMemberId },
  });
};

// ---------- created ----------

/** The ticket's row on the board, read from the tracker and cached when the delegation came first. */
const cachedTicketId = async (
  deps: AgentModeDeps,
  tracker: TrackerAdapter,
  board: { readonly id: string; readonly externalId: string },
  event: AgentSessionEvent,
): Promise<string | null> => {
  const externalId = externalTicketIdSchema.parse(event.ticketExternalId);
  const cached = await deps.db.ticket.findUnique({
    where: { boardId_externalId: { boardId: board.id, externalId } },
    select: { id: true, removedAt: true },
  });
  if (cached !== null) {
    return cached.removedAt === null ? cached.id : null;
  }
  const read = await tracker.getTicket({ externalId: board.externalId }, { externalId });
  if (!read.ok) {
    if (read.error.code === "rate-limited" || read.error.code === "unavailable") {
      throw new Error(`the tracker couldn't read the ticket (${read.error.code})`);
    }
    return null;
  }
  const boards = await boardsOnSameTeam(deps.db, boardIdSchema.parse(board.id));
  const upserted = await deps.db.$transaction((tx) =>
    upsertTicketCacheInTx(tx, boards, read.value),
  );
  const row = await deps.db.ticket.findFirst({
    where: { id: { in: [...upserted.ticketIds] }, boardId: board.id },
    select: { id: true },
  });
  return row?.id ?? null;
};

const handleCreated = async (
  deps: AgentModeDeps,
  tracker: TrackerAdapter,
  input: AgentEventInput,
): Promise<AgentEventOutcome> => {
  const { organizationId, connectionId, event } = input;
  const replayed = await deps.db.agentSession.findUnique({
    where: { connectionId_externalSessionId: { connectionId, externalSessionId: event.sessionId } },
    select: { id: true, taskId: true },
  });
  if (replayed !== null) {
    // The same session's `created` again: it has its task already.
    return {
      agentSessionId: agentSessionIdSchema.parse(replayed.id),
      taskId: replayed.taskId === null ? null : taskIdSchema.parse(replayed.taskId),
      posted: [],
      ignored: "the session exists",
    };
  }
  const board = await deps.db.board.findFirst({
    where: {
      organizationId,
      connectionId,
      externalId: event.teamExternalId,
      agentMode: true,
      detachedAt: null,
    },
    select: { id: true, projectId: true, externalId: true },
  });
  const ticketId = board === null ? null : await cachedTicketId(deps, tracker, board, event);
  const email =
    board === null || ticketId === null ? null : await addressOf(tracker, event.creator);
  const byName = nameOf(event.creator.name);
  const now = deps.clock.now();

  return deps.db.$transaction(async (tx) => {
    const inserted = await tx.agentSession.createManyAndReturn({
      data: [
        {
          organizationId,
          connectionId,
          externalSessionId: event.sessionId,
          creatorExternalId: event.creator.userId.slice(0, 256),
          creatorName: byName,
          heartbeatDueAt: new Date(now + deps.heartbeatMs),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    const [row] = inserted;
    if (row === undefined) {
      // Another delivery of this session's `created` got here first.
      const existing = await tx.agentSession.findUniqueOrThrow({
        where: {
          connectionId_externalSessionId: { connectionId, externalSessionId: event.sessionId },
        },
        select: { id: true },
      });
      return {
        agentSessionId: agentSessionIdSchema.parse(existing.id),
        taskId: null,
        posted: [],
        ignored: "the session exists",
      };
    }
    const agentSessionId = agentSessionIdSchema.parse(row.id);
    const post = (moment: AgentSessionMoment, final: boolean) =>
      writeMomentToSessionInTx(deps, tx, {
        organizationId,
        agentSessionId,
        connectionId,
        moment,
        key: "created",
        final,
        at: now,
      });
    if (board === null || ticketId === null) {
      // No project takes this team's delegations: say so, and end the session.
      await post({ kind: "no-board" }, true);
      return { agentSessionId, taskId: null, posted: ["no-board"] };
    }
    const projectId = projectIdSchema.parse(board.projectId);
    const match = await matchStarterInTx(tx, organizationId, projectId, {
      userId: event.creator.userId,
      name: byName,
      email,
    });
    const matchedMemberId = match.kind === "member" ? match.memberId : null;
    const started = await startFromTrackerInTx(
      {
        tx,
        jobs: deps.jobs,
        notices: deps.notices,
        audit: deps.audit,
        clock: deps.clock,
        publicUrl: deps.publicUrl,
      },
      {
        organizationId,
        projectId,
        ticketId: ticketIdSchema.parse(ticketId),
        actor: { externalId: event.creator.userId, name: byName },
        matchedMemberId,
        agentSessionId,
      },
    );
    let taskId: TaskId;
    let awaitingApproval = false;
    if (started.ok) {
      taskId = started.taskId;
      awaitingApproval = started.awaitingApproval;
    } else if (started.error === "ticket-has-task") {
      // A delegation of a ticket that's being worked on joins its task.
      taskId = started.taskId;
    } else {
      await tx.agentSession.update({
        where: { id: agentSessionId },
        data: { projectId, matchedMemberId },
      });
      await post(
        {
          kind: "not-started",
          projectUrl: `${deps.publicUrl.replace(/\/+$/, "")}/projects/${projectId}`,
        },
        true,
      );
      deps.logger.info("linear.agent-event.not-started", {
        organizationId,
        connectionId,
        agentSessionId,
        reason: started.error,
      });
      return { agentSessionId, taskId: null, posted: ["not-started"] };
    }
    await tx.agentSession.update({
      where: { id: agentSessionId },
      data: {
        projectId,
        ticketId,
        taskId,
        boardId: board.id,
        matchedMemberId,
        state: awaitingApproval ? "awaiting_approval" : "active",
      },
    });
    await sessionEventInTx(
      tx,
      { organizationId, projectId, taskId, now },
      "created",
      byName,
      matchedMemberId,
    );
    const taskUrl = taskPageUrl(deps.publicUrl, taskId);
    const moment: AgentSessionMoment = awaitingApproval
      ? { kind: "waiting-for-approval", taskUrl }
      : { kind: "received", taskUrl };
    await post(moment, false);
    return { agentSessionId, taskId, posted: [moment.kind] };
  });
};

// ---------- prompted: a stop ----------

/**
 * Stops the task as a stop from the tracker, in the caller's transaction: milestone 2's stop path
 * (the task stopped, a `stop` command in the outbox for the lease's runner, which whichever replica
 * holds its connection delivers), with the tracker user named in the audit entry.
 */
const stopFromTrackerInTx = async (
  deps: AgentModeDeps,
  tx: Tx,
  organizationId: OrganizationId,
  taskId: TaskId,
  byName: string,
): Promise<boolean> => {
  const locked = await tx.$queryRaw<
    readonly unknown[]
  >`SELECT "id" FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return false;
  }
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  const current = taskFromColumns(task);
  if (!current.ok) {
    throw new Error(`a task row breaks its lifecycle: ${current.reason}`);
  }
  const moved = transitionTask(current.value, { type: "stop", reason: "requested" });
  if (!moved.ok) {
    return false;
  }
  await tx.task.update({ where: { id: taskId }, data: taskToColumns(moved.state) });
  const now = deps.clock.now();
  await closeItemsOfEndedTaskInTx(deps, tx, taskId, { at: new Date(now), byMemberId: null });
  const projectId = projectIdSchema.parse(task.projectId);
  const lease = await tx.lease.findFirst({
    where: { taskId, state: "active" },
    select: { runnerId: true, epoch: true },
  });
  const session = await tx.session.findFirst({
    where: { taskId, state: { in: ["starting", "running", "waiting", "idle"] } },
    select: { id: true },
  });
  if (lease !== null && session !== null) {
    await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
      kind: "stop",
      body: {
        taskId,
        sessionId: sessionIdSchema.parse(session.id),
        leaseEpoch: leaseEpochSchema.parse(lease.epoch),
        reason: "requested",
      },
      notAfter: now + runnerLimits.graceMs,
      task: { taskId, projectId },
    });
  } else if (session !== null) {
    // Never dispatched: nothing will end the session but this.
    await tx.session.update({
      where: { id: session.id },
      data: { state: "stopped", endedAt: new Date(now) },
    });
  }
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "system", id: null },
    action: "task.stopped",
    entity: "task",
    entityId: taskId,
    data: { dispatched: lease !== null, via: "linear", trackerUser: byName },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
  return true;
};

type SessionRow = {
  readonly id: string;
  readonly state: "active" | "awaiting_approval" | "ended";
  readonly taskId: string | null;
  readonly projectId: string | null;
};

const handleStop = async (
  deps: AgentModeDeps,
  input: AgentEventInput,
  session: SessionRow & { readonly taskId: string; readonly projectId: string },
): Promise<AgentEventOutcome> => {
  const { organizationId, connectionId, event } = input;
  const agentSessionId = agentSessionIdSchema.parse(session.id);
  const taskId = taskIdSchema.parse(session.taskId);
  const projectId = projectIdSchema.parse(session.projectId);
  const byName = nameOf(event.creator.name);
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      readonly { readonly state: string }[]
    >`SELECT "state" FROM "agent_session" WHERE "id" = ${agentSessionId} FOR UPDATE`;
    if (rows[0]?.state === "ended") {
      // A stop is honoured once: the session has had its last word.
      return { agentSessionId, taskId, posted: [], ignored: "the session has ended" };
    }
    // The final response first: it ends the session, so the stop's own move tells it nothing more.
    await writeMomentToSessionInTx(deps, tx, {
      organizationId,
      agentSessionId,
      connectionId,
      moment: { kind: "stopped-in-linear" },
      key: input.deliveryId,
      final: true,
      at: now,
    });
    await stopFromTrackerInTx(deps, tx, organizationId, taskId, byName);
    await sessionEventInTx(tx, { organizationId, projectId, taskId, now }, "stop", byName, null);
    return { agentSessionId, taskId, posted: ["stopped-in-linear"] };
  });
};

// ---------- prompted: a follow-up ----------

const handleFollowUp = async (
  deps: AgentModeDeps,
  tracker: TrackerAdapter,
  input: AgentEventInput,
  session: SessionRow & { readonly taskId: string; readonly projectId: string },
): Promise<AgentEventOutcome> => {
  const { organizationId, connectionId, event } = input;
  const agentSessionId = agentSessionIdSchema.parse(session.id);
  const taskId = taskIdSchema.parse(session.taskId);
  const projectId = projectIdSchema.parse(session.projectId);
  const byName = nameOf(event.creator.name);
  const text = event.prompt ?? "";
  const email = await addressOf(tracker, event.creator);
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const match = await matchStarterInTx(tx, organizationId, projectId, {
      userId: event.creator.userId,
      name: byName,
      email,
    });
    const scope =
      match.kind === "member" ? await memberScopeInTx(tx, organizationId, match.memberId) : null;
    const post = (moment: AgentSessionMoment) =>
      writeMomentToSessionInTx(deps, tx, {
        organizationId,
        agentSessionId,
        connectionId,
        moment,
        key: input.deliveryId,
        final: false,
        at: now,
      });
    if (scope === null || text.trim() === "") {
      // Only the project's members steer its tasks: nothing of this reaches the agent.
      await post({ kind: "follow-up-not-member" });
      await sessionEventInTx(
        tx,
        { organizationId, projectId, taskId, now },
        "follow-up",
        byName,
        null,
      );
      return { agentSessionId, taskId, posted: ["follow-up-not-member"] };
    }
    const sent = await sendMemberMessageInTx(
      {
        jobs: deps.jobs,
        outbox: deps.outbox,
        notices: deps.notices,
        audit: deps.audit,
        clock: deps.clock,
        spendCap: deps.spendCap,
        timers: deps.timers,
        files: deps.files,
      },
      tx,
      scope,
      {
        taskId,
        clientMessageId: clientMessageIdSchema.parse(`linear-${input.deliveryId}`),
        text,
        intent: "linear-follow-up",
        sender: "anyone",
      },
    );
    if (!sent.ok) {
      deps.logger.info("linear.follow-up-refused", {
        organizationId,
        agentSessionId,
        taskId,
        reason: sent.error,
      });
      return {
        agentSessionId,
        taskId,
        posted: [],
        ignored: `the follow-up couldn't be sent (${sent.error})`,
      };
    }
    await post({ kind: "follow-up-queued" });
    await sessionEventInTx(
      tx,
      { organizationId, projectId, taskId, now },
      "follow-up",
      byName,
      memberIdSchema.parse(scope.memberId),
    );
    return { agentSessionId, taskId, posted: ["follow-up-queued"] };
  });
};

/** `handleAgentSessionEvent`: one event, acted on once. */
export const handleAgentSessionEvent = async (
  deps: AgentModeDeps,
  tracker: TrackerAdapter,
  input: AgentEventInput,
): Promise<AgentEventOutcome> => {
  if (input.event.action === "created") {
    return handleCreated(deps, tracker, input);
  }
  const session = await deps.db.agentSession.findUnique({
    where: {
      connectionId_externalSessionId: {
        connectionId: input.connectionId,
        externalSessionId: input.event.sessionId,
      },
    },
    select: { id: true, state: true, taskId: true, projectId: true },
  });
  if (session === null) {
    return { agentSessionId: null, taskId: null, posted: [], ignored: "no such session" };
  }
  const { taskId, projectId } = session;
  if (taskId === null || projectId === null) {
    return {
      agentSessionId: agentSessionIdSchema.parse(session.id),
      taskId: null,
      posted: [],
      ignored: "the session has no task",
    };
  }
  const withTask = { ...session, taskId, projectId };
  if (input.event.signal === "stop") {
    return handleStop(deps, input, withTask);
  }
  if (session.state === "ended") {
    return {
      agentSessionId: agentSessionIdSchema.parse(session.id),
      taskId: taskIdSchema.parse(taskId),
      posted: [],
      ignored: "the session has ended",
    };
  }
  return handleFollowUp(deps, tracker, input, withTask);
};

/** The job: the claimed delivery, read by the connection's adapter, acted on, then marked. */
export const agentEventHandler =
  (deps: AgentModeDeps): JobHandler<"linear.agent-event"> =>
  async (context) => {
    const { organizationId, connectionId, deliveryId } = context.payload;
    const logger = context.logger.child({ organizationId, connectionId, deliveryId });
    const delivery = await deps.db.webhookDelivery.findFirst({
      where: { organizationId, connectionId, deliveryId },
      select: { id: true, status: true, payload: true },
    });
    if (delivery === null) {
      logger.warn("linear.agent-event.missing", {});
      return;
    }
    if (delivery.status !== "received") {
      return;
    }
    const mark = async (
      status: "processed" | "ignored" | "failed",
      reason: string | null,
    ): Promise<void> => {
      await deps.db.webhookDelivery.updateMany({
        where: { id: delivery.id, status: "received" },
        data: {
          status,
          processedAt: new Date(deps.clock.now()),
          error: reason === null ? null : reason.slice(0, 500),
        },
      });
    };
    const lookup = await deps.trackers.forConnection(
      organizationIdSchema.parse(organizationId),
      connectionId,
    );
    if (!lookup.ok) {
      if (lookup.reason === "no-token") {
        throw new Error(lookup.message);
      }
      await mark("failed", `the connection can't take agent sessions: ${lookup.message}`);
      return;
    }
    const tracker = lookup.value.tracker;
    if (!tracker.capabilities.agentSessions) {
      await mark("ignored", "the tracker has no agent sessions");
      return;
    }
    const parsed = tracker.parseAgentSessionEvent(delivery.payload);
    if (!parsed.ok) {
      await mark("ignored", "not an agent session event the adapter reads");
      return;
    }
    const outcome = await handleAgentSessionEvent(deps, tracker, {
      organizationId,
      connectionId,
      deliveryId,
      event: parsed.value,
    });
    await mark(outcome.ignored === undefined ? "processed" : "ignored", outcome.ignored ?? null);
    // The post goes out now: Linear wants a session's first activity within 10 s, and the queue's
    // next poll may be seconds away. The outbox's own job, finding it sent, does nothing; a post
    // that fails here is left to it, with its backoff.
    if (outcome.agentSessionId !== null && outcome.posted.length > 0) {
      const pending = await deps.db.agentActivity.findMany({
        where: { agentSessionId: outcome.agentSessionId, state: "pending" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      for (const { id } of pending) {
        await sendActivity(
          deps,
          organizationIdSchema.parse(organizationId),
          agentActivityIdSchema.parse(id),
          logger,
        ).catch((error: unknown) => {
          logger.info("linear.activity.left-to-the-queue", {
            error: error instanceof Error ? error.name : "unknown",
          });
        });
      }
    }
    logger.info("linear.agent-event", {
      action: parsed.value.action,
      stop: parsed.value.signal === "stop",
      agentSessionId: outcome.agentSessionId,
      taskId: outcome.taskId,
      posted: outcome.posted.join(","),
    });
  };
